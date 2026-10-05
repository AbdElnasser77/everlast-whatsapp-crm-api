const cookie = require("cookie");
const jwt = require("jsonwebtoken");
const prisma = require("../config/prisma");
const numbers = require("./whatsappNumbers");
const { mayUseNumber } = require("../middleware/whatsappNumber");

const numberRoom = (numberId) => `number:${numberId}`;

let io;

const initSocket = (httpServer) => {
  io = require("socket.io")(httpServer, {
    cors: {
      origin: process.env.FRONTEND_URL || "http://localhost:3000",
      credentials: true,
    },
  });

  // Authenticate every socket connection. The browser sends the httpOnly JWT
  // cookie on the handshake (client must use withCredentials); non-browser
  // clients may pass the token via handshake auth instead. Reject anything
  // without a valid token so message events are never broadcast to strangers.
  io.use(async (socket, next) => {
    try {
      const cookies = cookie.parse(socket.handshake.headers.cookie || "");
      const token = cookies.token || socket.handshake.auth?.token;
      if (!token) return next(new Error("Unauthorized"));

      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // Same authoritative check as middleware/auth.js. Trusting the handshake
      // claims alone would let a deactivated or deleted user keep receiving
      // every message.created event in the system for up to 8 hours.
      //
      // findUnique, not update: a socket lives for hours, so bumping
      // lastActiveAt here would make "last active" meaningless.
      const user = await prisma.user.findUnique({
        where: { id: decoded.id },
        select: { id: true, username: true, role: true, isActive: true },
      });
      if (!user || !user.isActive) return next(new Error("Unauthorized"));

      socket.user = { id: user.id, username: user.username, role: user.role };
      next();
    } catch {
      next(new Error("Unauthorized"));
    }
  });

  io.on("connection", async (socket) => {
    // Per-user room so user.controller can force-disconnect one specific
    // account the instant it's deactivated, deleted, or demoted. This room is
    // only ever a kick target.
    socket.join(`user:${socket.user.id}`);

    // Join the number room from the HANDSHAKE, before any event can be
    // delivered. Doing it here rather than via a follow-up "subscribe" emit is
    // what removes the window in which the previous number's events would still
    // arrive after the user switched.
    await joinNumberRoom(socket, socket.handshake.auth?.whatsappNumberId);

    console.log("Socket client connected:", socket.id, "user:", socket.user?.username);

    // Kept as well as the handshake join: a client that switches numbers without
    // reconnecting can re-room in place.
    socket.on("number.subscribe", async (payload, ack) => {
      const id = typeof payload === "object" && payload !== null ? payload.whatsappNumberId : payload;
      const ok = await joinNumberRoom(socket, id);
      if (typeof ack === "function") ack({ ok, whatsappNumberId: socket.data.whatsappNumberId ?? null });
    });

    // The number is taken from the socket's own room, never from the client
    // payload — otherwise a client could inject typing indicators into another
    // number's inbox.
    socket.on("typing.start", ({ conversationId, username }) => {
      const room = socket.data.whatsappNumberId;
      if (!room) return;
      socket.to(numberRoom(room)).emit("typing.start", { conversationId, username });
    });

    socket.on("typing.stop", ({ conversationId, username }) => {
      const room = socket.data.whatsappNumberId;
      if (!room) return;
      socket.to(numberRoom(room)).emit("typing.stop", { conversationId, username });
    });

    socket.on("disconnect", () => {
      console.log("Socket client disconnected:", socket.id);
    });
  });

  return io;
};

// Move a socket into exactly one number room, validating that the user may use
// it. Falls back to the default number so a client that sends nothing still
// receives its own traffic rather than silently receiving none.
const joinNumberRoom = async (socket, requestedId) => {
  try {
    const id = Number(requestedId);
    let number = Number.isInteger(id) && id > 0 ? await numbers.getById(id) : null;
    if (!number || !number.isActive) number = await numbers.getDefault();
    if (!number || !mayUseNumber(socket.user, number)) return false;

    for (const room of socket.rooms) {
      if (room.startsWith("number:")) socket.leave(room);
    }
    socket.join(numberRoom(number.id));
    socket.data.whatsappNumberId = number.id;
    return true;
  } catch (err) {
    console.error("Socket: failed to join number room:", err.message);
    return false;
  }
};

const getIO = () => {
  if (!io) throw new Error("Socket.IO not initialized");
  return io;
};

// Emit to everyone currently viewing one number. Every scoped event must go
// through this rather than io.emit — a global broadcast leaks one line's
// messages, unread counts and campaign progress to agents working another.
//
// The id is stamped into the payload as well as used for routing, so a client
// can still tell events apart if it is ever in more than one room.
const emitToNumber = (numberId, event, payload) => {
  if (!io) return;
  if (numberId === null || numberId === undefined) {
    console.warn(`Socket: "${event}" emitted with no number — dropped rather than broadcast`);
    return;
  }
  io.to(numberRoom(numberId)).emit(event, { ...payload, whatsappNumberId: numberId });
};

// For genuinely account-wide events that are not tied to one line.
const emitGlobal = (event, payload) => {
  if (!io) return;
  io.emit(event, payload);
};

// Drop every live socket belonging to one user. Called after deactivate,
// delete, and role change so the socket layer can't outlive the HTTP layer's
// authoritative check.
//
// Checks `io` directly rather than calling getIO(), which throws when the
// socket layer was never initialised — e.g. under `npm run seed`.
const disconnectUser = (userId) => {
  if (!io) return;
  io.in(`user:${userId}`).disconnectSockets(true);
};

module.exports = { initSocket, getIO, disconnectUser, emitToNumber, emitGlobal };
