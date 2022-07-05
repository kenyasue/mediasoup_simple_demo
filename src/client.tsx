import * as mediasoupClient from "mediasoup-client";
import React, { useState, useEffect, useRef } from "react";
import ReactDom from "react-dom";
import { createRoot } from 'react-dom/client';
import { faker } from '@faker-js/faker';
import CSS from 'csstype';

/////////////////////////////////////////////////////////////////////
// Types
/////////////////////////////////////////////////////////////////////
enum MyStreamingState {
    NotJoined,
    Joind,
    AudioReady,
    VideoReady,
    StartStreaming,
    WaitingConsumer,
    Established
};

class EventSouceWrapper {

    source: EventSource;

    constructor() {
    }

    connect(url: string, func: (eventResponse: any) => void): void {

        this.source = new EventSource(url);
        this.source.addEventListener('message', (messageEvent: MessageEvent<string>) => {
            func(JSON.parse(messageEvent.data))
        });

    }

    disconnect(): void {
        this.source?.close();
    }

}
/////////////////////////////////////////////////////////////////////
// Libs
/////////////////////////////////////////////////////////////////////

const useServerEvent = () => {
    const [eventSource, setEventSource] = useState<EventSouceWrapper>(new EventSouceWrapper());
    return eventSource;
}

const fetchPost = async (url: string, data: any): Promise<any> => {
    const fetchResponse: Response = await fetch(url, {
        method: 'POST',
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(data)
    });

    const json = await fetchResponse.json();
    return json;
}

/////////////////////////////////////////////////////////////////////
// Main
/////////////////////////////////////////////////////////////////////

let roomId = window.location.href.split("/").pop();
if (!roomId) {
    roomId = faker.random.alphaNumeric(8);
}

const styles: Record<string, CSS.Properties> = {
    header: {
        borderBottom: "1px solid #333",
        display: "flex",
        flexDirection: "row"
    },
    headerProgress: {
        display: "flex",
        flexDirection: "row"
    },
    videoContainerMe: {
        height: "50vw",
        maxHeight: "90vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center"
    },
    videoContainerParticipant: {
        height: "50vw",
        maxHeight: "90vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center"
    },
    videoContainer: {
        border: "1px solid #333",
        borderRadius: "10px",
        width: "100%",
        height: "100%",
        margin: "15px"
    },
    video: {
        width: "100%",
        height: "100%",
        padding: "2px",
        objectFit: "cover",
        borderRadius: "10px",
    }

}

let mediasoupParams: any = {
    // mediasoup params
    encodings: [
        {
            rid: 'r0',
            maxBitrate: 100000,
            scalabilityMode: 'S1T3',
        },
        {
            rid: 'r1',
            maxBitrate: 300000,
            scalabilityMode: 'S1T3',
        },
        {
            rid: 'r2',
            maxBitrate: 900000,
            scalabilityMode: 'S1T3',
        },
    ],
    // https://mediasoup.org/documentation/v3/mediasoup-client/api/#ProducerCodecOptions
    codecOptions: {
        videoGoogleStartBitrate: 1000
    }
}

let device: mediasoupClient.types.Device = new mediasoupClient.Device();
let myVideoStream: MediaStream;
let rtpCapabilities: mediasoupClient.types.RtpCapabilities;
let producerTransport: mediasoupClient.types.Transport;
let producer: mediasoupClient.types.Producer;
let consumerTransport: mediasoupClient.types.Transport;
let consumer: mediasoupClient.types.Consumer;

export default function App(): React.ReactElement {

    const [serverReady, setServerReady] = useState<boolean>(false);
    const [userName, setUserName] = useState<string>("");
    const [state, setState] = useState<MyStreamingState>(MyStreamingState.NotJoined);
    const [peerId, setPeerId] = useState<string>("");
    const localVideoRef = useRef<HTMLVideoElement>(null);
    const remoteVideoRef = useRef<HTMLVideoElement>(null);
    const eventListener = useServerEvent();

    useEffect(() => {
        if (!localVideoRef.current || !myVideoStream) return;
        localVideoRef.current.srcObject = myVideoStream;
    }, [localVideoRef, myVideoStream]);

    useEffect(() => {

    }, [state]);

    const join: () => void = async () => {

        try {

            // flow to start streaming
            // 1. Tell the server the name 
            // 2. Server sends the necessary information 
            // 3. Initialize the mic and cam
            // 4. Prepare for start streaming
            // 5. Start streaming
            const joinResponse: any = await fetchPost(`/api/room/${roomId}/join`, {
                name: userName
            });

            if (!joinResponse?.peer?.peerId) return alert("Invalid response");
            if (!joinResponse?.rtpCapabilities) return alert("Invalid response");
            if (!joinResponse?.transportParams || !joinResponse?.transportParams?.id) return alert("Invalid response");

            setPeerId(joinResponse.peer.peerId);
            setState(MyStreamingState.Joind);

            const peerIdClosure: string = joinResponse.peer.peerId;
            // start listening events
            eventListener.connect(`/api/event/${roomId}/${joinResponse.peer.peerId}`, (eventResponse: {
                command: string,
                data: any
            }) => {

                const eventCommand = eventResponse.command;
                if (!eventCommand) return;

                if (eventCommand === 'new_peer') {

                    setState(MyStreamingState.WaitingConsumer);

                    const peerData = eventResponse.data;

                    // ignore myself
                    if (peerData.peerId === peerIdClosure) return;

                    // handlernew peer
                    (async () => {

                        //start receiving here
                        const params = await fetchPost(`/api/room/${roomId}/receiveTransport`, {
                            peerId: peerIdClosure
                        });

                        consumerTransport = device.createRecvTransport(params);
                        consumerTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {

                            try {

                                await fetchPost(`/api/room/${roomId}/receiveConnected`, {
                                    peerId: peerIdClosure,
                                    dtlsParameters
                                });

                                callback()

                            } catch (error) {
                                // Tell the transport that something was wrong
                                errback(error)
                            }

                        });


                        const consumerParams = await fetchPost(`/api/room/${roomId}/startConsuming`, {
                            peerId: peerIdClosure,
                            rtpCapabilities: device.rtpCapabilities
                        });

                        consumer = await consumerTransport.consume({
                            id: consumerParams.id,
                            producerId: peerData.producerId,
                            kind: consumerParams.kind,
                            rtpParameters: consumerParams.rtpParameters
                        });

                        // destructure and retrieve the video track from the producer
                        const { track } = consumer

                        remoteVideoRef.current!.srcObject = new MediaStream([track])

                        setState(MyStreamingState.Established);

                    })();

                }

            })

            rtpCapabilities = joinResponse.rtpCapabilities;

            // initialize camera and microphone
            myVideoStream = await navigator.mediaDevices.getUserMedia({
                audio: true,
                video: true
            });

            const track = myVideoStream.getVideoTracks()[0];

            mediasoupParams = {
                track,
                ...mediasoupParams
            }

            setState(MyStreamingState.VideoReady);

            // create device
            device = new mediasoupClient.Device()

            await device.load({
                routerRtpCapabilities: rtpCapabilities
            });

            producerTransport = device.createSendTransport(joinResponse.transportParams)

            producerTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {

                try {

                    await fetchPost(`/api/room/${roomId}/transportConnect`, {
                        peerId: joinResponse.peer.peerId,
                        dtlsParameters
                    });

                    callback();

                } catch (error) {
                    errback(error);
                    eventListener.disconnect();
                    setState(MyStreamingState.NotJoined);
                }
            });

            producerTransport.on('produce', async (parameters, callback, errback) => {

                try {

                    const response = await fetchPost(`/api/room/${roomId}/transportProduce`, {
                        peerId: joinResponse.peer.peerId,
                        kind: parameters.kind,
                        rtpParameters: parameters.rtpParameters,
                        appData: parameters.appData,
                    });

                    if (response.producerId) {
                        setState(MyStreamingState.StartStreaming);
                        callback({ id: response.producerId });
                    }


                } catch (error) {
                    errback(error);
                    eventListener.disconnect();
                    setState(MyStreamingState.NotJoined);
                }
            });

            producer = await producerTransport.produce(mediasoupParams)

            producer.on('trackended', () => {
                console.log('track ended')

                // close video track
            })

            producer.on('transportclose', () => {
                console.log('transport ended')

                // close video track
            })

        } catch (error) {
            console.log(error);
            eventListener.disconnect();
            setState(MyStreamingState.NotJoined);
            alert("Failed to join.")
        }

    }

    return (
        <div className="container-fluid">
            <div className="row" >
                <div className="col-12 pt-3 pb-3" style={styles.header}>
                    <div className="me-3">
                        Your room id is <strong>{roomId}</strong><br />
                        Name <strong>{userName}</strong><br />
                        {peerId && <>PeerId <strong>{peerId}</strong></>}
                    </div>
                    <div className="show-progress">
                        <div style={styles.headerProgress}>
                            <span className={`badge ${state > MyStreamingState.NotJoined ? "bg-primary" : "bg-secondary"} me-1`}>Join</span>
                            <span className={`badge ${state >= MyStreamingState.AudioReady ? "bg-primary" : "bg-secondary"} me-1`}>Mic Ready</span>
                            <span className={`badge ${state >= MyStreamingState.VideoReady ? "bg-primary" : "bg-secondary"} me-1`}>Camera Ready</span>
                            <span className={`badge ${state >= MyStreamingState.StartStreaming ? "bg-primary" : "bg-secondary"} me-1`}>Connection Ready</span>
                            <span className={`badge ${state >= MyStreamingState.WaitingConsumer ? "bg-primary" : "bg-secondary"} me-1`}>Waiting participant</span>
                            <span className={`badge ${state >= MyStreamingState.Established ? "bg-primary" : "bg-secondary"} me-1`}>Established</span>
                            {
                                state > MyStreamingState.NotJoined &&
                                <span className={`badge bg-danger me-1`} style={{ cursor: "pointer" }} onClick={() => {
                                    setState(MyStreamingState.NotJoined);
                                    eventListener.disconnect();
                                }}>Disconnect</span>

                            }

                        </div>
                        <div>Please join to the room.</div>
                    </div>
                </div>
            </div>

            <div className="row">
                <div className="col-sm-6" style={styles.videoContainerMe}>

                    {state >= MyStreamingState.VideoReady &&
                        <div style={styles.videoContainer}>
                            <video autoPlay ref={localVideoRef} style={styles.video}></video>
                        </div>
                    }
                    {state < MyStreamingState.VideoReady &&
                        <div style={{ textAlign: "right" }}>
                            <input placeholder="Type your name..."
                                className="mb-1"
                                onChange={e => setUserName(e.target.value)}
                                value={userName} /><br />
                            <button type="button" className="btn btn-primary" onClick={join} disabled={state > MyStreamingState.NotJoined}>Join</button>
                        </div>
                    }

                </div>
                <div className="col-sm-6" style={styles.videoContainerParticipant}>
                    <video autoPlay ref={remoteVideoRef} style={styles.video}></video>
                    {/*<div style={{ textAlign: "center" }}>
                        <i className="bi bi-person-video"></i><br />Waiting video
                        <video autoPlay ref={remoteVideoRef} style={styles.video}></video>
                </div>*/}
                </div>
            </div>
        </div >
    );
}

const container: Element = document.getElementById('app')!;
const root = createRoot(container!);
root.render(<App />);
