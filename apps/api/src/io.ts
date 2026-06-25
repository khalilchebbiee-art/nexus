import type { Server } from "socket.io";

let ioRef: Server | null = null;

// Set of currently-connected user ids (presence).
export const onlineUsers = new Set<string>();

export function setIo(io: Server) {
  ioRef = io;
}

export function emitToUser(userId: string, event: string, payload: unknown) {
  ioRef?.to(`user:${userId}`).emit(event, payload);
}
