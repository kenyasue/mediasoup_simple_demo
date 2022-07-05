
//https://github.com/jamalag/mediasoup/blob/main/example1/public/index.html
//https://github.com/jamalag/mediasoup/blob/main/example1/public/index.js

import dotenv from "dotenv";
dotenv.config();

import express from "express";
import http from "http";
import path from "path";
import * as mediasoup from "mediasoup";
import { faker } from '@faker-js/faker';
import PubSub from 'pubsub-js'

////////////////////////////////////////////////////////////////////////////
// Type Definitions
////////////////////////////////////////////////////////////////////////////
type TemplateParams = {
    title: string
}

type Peer = {
    peerId: string,
    roomId: string,
    name: string
    producerTransports?: Array<mediasoup.types.Transport>;
    consumerTransports?: Array<mediasoup.types.Transport>;
    producer?: mediasoup.types.Producer;
    consumers?: Array<mediasoup.types.Consumer>;
}

type Room = {
    transport?: mediasoup.types.Transport;
    router?: mediasoup.types.Router;
    peers: Record<string, Peer>;
}

////////////////////////////////////////////////////////////////////////////
// Server side
////////////////////////////////////////////////////////////////////////////
const app: express.Express = express();
const rooms: Record<string, Room> = {};


const webRtcTransport_options = {
    listenIps: [
        {
            ip: '127.0.0.1', // replace with relevant IP address
            announcedIp: '127.0.0.1',
        }
    ],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
}

const mediaCodecs: Array<any> = [
    {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2,
    },
    {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000,
        parameters: {
            'x-google-start-bitrate': 1000,
        },
    }
];

(async () => {

    // create mediasoup worker
    const mediasoupWorker: mediasoup.types.Worker = await mediasoup.createWorker({
        rtcMinPort: 2000,
        rtcMaxPort: 2020,
    })

    mediasoupWorker.on('died', (error: Error) => {
        // This implies something serious happened, so kill the application
        console.error('mediasoup worker has died')
        setTimeout(() => process.exit(1), 2000) // exit in 2 seconds
    })

    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    // cors
    app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
        res.header("Access-Control-Allow-Origin", "*");
        res.header("Access-Control-Allow-Methods", "*");
        res.header("Access-Control-Allow-Headers", "*");
        res.header(
            "Access-Control-Allow-Headers",
            "Content-Type, Authorization, access-token"
        );

        // intercept OPTIONS method
        if ("OPTIONS" === req.method) {
            res.sendStatus(200);
        } else {
            next();
        }
    });

    const server: http.Server = app.listen(process.env["SERVER_PORT"], () => {
        console.log(`Start on port ${process.env["SERVER_PORT"]}.`);
    });

    app.use(express.static('public'))

    app.post('/api/room/:roomId/join', async function (req, res) {

        try {
            const roomId: string = req.params.roomId;

            if (!req.body.name || req.body.name.length < 4)
                return res.status(400).send("Invalid params");

            //reject if room is full
            if (rooms[roomId] && Object.keys(rooms[roomId].peers).length >= 2)
                return res.status(400).send("Room is full");

            const name = req.body.name;

            // create peer
            const peerId = faker.random.alphaNumeric(8);

            const newPeer: Peer = {
                peerId,
                roomId: req.params.roomId,
                name: name,
                producerTransports: [],
                consumerTransports: [],
                consumers: []
            }

            rooms[roomId] ??= {
                peers: {},
                router: await mediasoupWorker.createRouter({ mediaCodecs }),
            }

            rooms[roomId].peers[peerId] = newPeer;

            // create transport

            // producer transport
            let transport = await rooms[roomId].router.createWebRtcTransport(webRtcTransport_options)
            rooms[roomId].peers[peerId].producerTransports.push(transport);

            transport.on('dtlsstatechange', dtlsState => {
                if (dtlsState === 'closed') {
                    transport?.close()
                }
            })

            res.json({
                peer: newPeer,
                rtpCapabilities: rooms[roomId].router.rtpCapabilities,
                transportParams: {
                    id: transport.id,
                    iceParameters: transport.iceParameters,
                    iceCandidates: transport.iceCandidates,
                    dtlsParameters: transport.dtlsParameters,
                }
            });


        } catch (e) {
            console.error(e);
            return res.status(500).send("Server error");
        }


    });


    app.post('/api/room/:roomId/transportConnect', async function (req, res) {

        try {

            const roomId: string = req.params.roomId;
            const dtlsParameters: any = req.body.dtlsParameters;
            if (!dtlsParameters) return res.status(400).send("Invalid params");

            const peerId: any = req.body.peerId;
            if (!peerId) return res.status(400).send("Invalid params");

            const provider = rooms[roomId].peers[peerId].producerTransports[0];
            if (!provider) return res.status(400).send("Invalid params");

            await provider!.connect({ dtlsParameters })

            res.status(200).json("OK");

        } catch (e) {
            console.error(e);
            return res.status(500).send("Server error");
        }


    });

    app.post('/api/room/:roomId/transportProduce', async function (req, res) {

        try {

            const roomId: string = req.params.roomId;
            const peerId: any = req.body.peerId;
            if (!peerId) return res.status(400).send("Invalid params");

            if (!req.body.kind) return res.status(400).send("Invalid params");
            if (!req.body.rtpParameters) return res.status(400).send("Invalid params");
            if (!req.body.appData) return res.status(400).send("Invalid params");

            const provider = rooms[roomId].peers[peerId].producerTransports[0];
            if (!provider) return res.status(400).send("Invalid params");

            // call produce based on the prameters from the client
            const producer: mediasoup.types.Producer = await provider.produce({
                kind: req.body.kind,
                rtpParameters: req.body.rtpParameters
            })

            rooms[roomId].peers[peerId].producer = producer;

            producer.on('transportclose', () => {
                console.log('transport for this producer closed ')
                producer.close()
            })

            const peer: Peer = rooms[roomId].peers[peerId];

            PubSub.publish(roomId, {
                command: "new_peer",
                data: {
                    peerId: peer.peerId,
                    name: peer.name,
                    producerId: peer.producer.id
                }
            });

            res.status(200).json({
                producerId: producer.id
            });

        } catch (e) {
            console.error(e);
            return res.status(500).send("Server error");
        }


    });


    app.post('/api/room/:roomId/receiveTransport', async function (req, res) {

        try {

            const roomId: string = req.params.roomId;

            const peerId: any = req.body.peerId;
            if (!peerId) return res.status(400).send("Invalid params");


            const room: Room = rooms[roomId];
            if (!room) return res.status(400).send("invalid params");

            const peer: Peer = room.peers[peerId];
            if (!peer) return res.status(400).send("Invalid params");

            let transport = await room.router.createWebRtcTransport(webRtcTransport_options);
            peer.consumerTransports.push(transport);

            res.status(200).json({
                id: transport.id,
                iceParameters: transport.iceParameters,
                iceCandidates: transport.iceCandidates,
                dtlsParameters: transport.dtlsParameters,
            });

        } catch (e) {
            console.error(e);
            return res.status(500).send("Server error");
        }


    });


    app.post('/api/room/:roomId/receiveConnected', async function (req, res) {

        try {

            const roomId: string = req.params.roomId;

            const peerId: any = req.body.peerId;
            if (!peerId) return res.status(400).send("Invalid params");

            const room: Room = rooms[roomId];
            if (!room) return res.status(400).send("invalid params");

            const peer: Peer = room.peers[peerId];
            if (!peer) return res.status(400).send("Invalid params");

            const dtlsParameters: any = req.body.dtlsParameters;
            if (!dtlsParameters) return res.status(400).send("Invalid params");

            await peer.consumerTransports[0].connect({ dtlsParameters })

            res.status(200).json("OK");

        } catch (e) {
            console.error(e);
            return res.status(500).send("Server error");
        }


    });



    app.post('/api/room/:roomId/startConsuming', async function (req, res) {

        try {

            const roomId: string = req.params.roomId;

            const peerId: any = req.body.peerId;
            if (!peerId) return res.status(400).send("Invalid params");

            const room: Room = rooms[roomId];
            if (!room) return res.status(400).send("invalid params");

            const peer: Peer = room.peers[peerId];
            if (!peer) return res.status(400).send("Invalid params");

            const rtpCapabilities: any = req.body.b;
            if (!peer) return res.status(400).send("Invalid params");

            if (!room.router.canConsume({
                producerId: peer.producer.id,
                rtpCapabilities
            })) return res.status(500).send("Streadming error");

            const consumer: mediasoup.types.Consumer = await peer.consumerTransports[0].consume({
                producerId: peer.producer.id,
                rtpCapabilities
            })

            consumer.on('transportclose', () => {
                console.log('transport close from consumer')
            })

            consumer.on('producerclose', () => {
                console.log('producer of consumer closed')
            })

            // from the consumer extract the following params
            // to send back to the Client
            const params = {
                id: consumer.id,
                producerId: peer.producer.id,
                kind: consumer.kind,
                rtpParameters: consumer.rtpParameters,
            }

            res.status(200).json(params);

        } catch (e) {
            console.error(e);
            return res.status(500).send("Server error");
        }


    });


    app.get('/api/event/:roomId/:peerId', async function (req, res) {

        const roomId: string = req.params.roomId;
        const peerId: string = req.params.peerId;

        res.set({
            'Cache-Control': 'no-cache',
            'Content-Type': 'text/event-stream',
            'Connection': 'keep-alive'
        });
        res.flushHeaders();

        // Tell the client to retry every 10 seconds if connectivity is lost
        res.write('retry: 10000\n\n');
        let count = 0;

        // subscribe to channel
        PubSub.subscribe(roomId, (msg, data) => {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        });

        setTimeout(() => {
            // notify the user about existed users
            Object.keys(rooms[roomId].peers).map(peerId => {

                const peer: Peer = rooms[roomId].peers[peerId];

                PubSub.publish(roomId, {
                    command: "new_peer",
                    data: {
                        peerId: peer.peerId,
                        name: peer.name,
                        producerId: peer.producer.id
                    }
                });

            });

        }, 1000)


        req.on('close', () => {

            const peer = rooms[roomId]?.peers[peerId];

            if (peer) {
                peer.producerTransports.map(tranport => {
                    tranport?.close();
                })

                peer.consumerTransports.map(tranport => {
                    tranport?.close();
                })

                delete rooms[roomId].peers[peerId];
            }

        });
    });

    app.get('/', (req: express.Request, res: express.Response) => {
        res.sendFile(path.join(__dirname, "../public/index.html"));
    });

    app.get('/:roomId', (req: express.Request, res: express.Response) => {
        res.sendFile(path.join(__dirname, "../public/index.html"));
    });

    // general error
    app.use(async (err: Error, req: express.Request, res: express.Response, next: () => void) => {
        console.error(err);
        return res.status(500).send(`Server Error ${err.message}`);
    });
})();

export default app;
