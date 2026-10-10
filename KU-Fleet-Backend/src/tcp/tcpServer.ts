// src/tcp/tcpServer.ts
import net from "net";
import Gt06 from "gt06";
import { handleParsedMessage } from "../services/gpsHandler";
import {
  extractCompleteFrames,
  MAX_BUFFERED_BYTES,
} from "./gt06Framing";

export async function startTcpServer(port: number) {
  const openSockets = new Set<net.Socket>();

  const server = net.createServer((client) => {
    // A GT06 tracker holds one long-lived TCP session and the ACK must be
    // written back on the same socket, so all parsing is scoped to `client`.
    const gt06 = new Gt06();
    let pending: Buffer = Buffer.alloc(0);

    openSockets.add(client);
    client.on("close", () => openSockets.delete(client));

    client.on("data", (data: Buffer) => {
      pending = Buffer.concat([pending, data]);

      if (pending.length > MAX_BUFFERED_BYTES) {
        console.error("GT06 receive buffer exceeded limit, resetting for this client");
        pending = Buffer.alloc(0);
        return;
      }

      // Only hand whole frames to the parser (see gt06Framing.ts for why).
      const { frames, rest } = extractCompleteFrames(pending);
      pending = rest;
      if (frames.length === 0) return;

      void (async () => {
        for (const frame of frames) {
          try {
            gt06.parse(frame);
          } catch (e: any) {
            // A malformed frame must never stop the frames after it.
            console.error("GT06 parse error:", e?.message ?? e);
            continue;
          }

          if (gt06.expectsResponse && gt06.responseMsg) {
            try {
              client.write(gt06.responseMsg);
            } catch (err) {
              console.error("GT06 ack write error:", (err as Error).message);
            }
          }

          for (const msg of gt06.msgBuffer as any[]) {
            try {
              await handleParsedMessage(msg);
            } catch (err) {
              console.error("Error handling parsed message:", err);
            }
          }

          gt06.clearMsgBuffer();
        }
      })();
    });

    client.on("end", () => {
      // client disconnected
    });

    client.on("error", (err) => {
      console.error("TCP client error:", err.message);
    });
  });

  // Resolve with the net.Server so graceful shutdown can stop accepting new
  // tracker sessions and close existing sockets.
  return new Promise<net.Server>((resolve, reject) => {
    server.listen(port, () => {
      console.log(`TCP server listening on port ${port}`);
      resolve(server);
    });

    server.on("error", (err) => {
      console.error("TCP server error:", err);
      reject(err);
    });
  }).then((srv) => {
    (
      srv as net.Server & { closeAllTrackerSockets?: () => void }
    ).closeAllTrackerSockets = () => {
      for (const socket of openSockets) socket.destroy();
      openSockets.clear();
    };
    return srv;
  });
}