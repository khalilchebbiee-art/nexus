import type { CallRecord, CallStats, Conversation, FriendRequest, GlobalSearch, Message, Notification, User } from "./types";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

export type Session = {
  token: string;
  user: User;
};

async function request<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers
    }
  });

  if (!response.ok) {
    // An authenticated request rejected by the server means the session is no
    // longer valid (expired / revoked). Signal the app to log out cleanly
    // instead of leaving the user in a broken, half-loaded state.
    if (response.status === 401 && token) {
      window.dispatchEvent(new Event("nexus-unauthorized"));
    }
    const body = await response.json().catch(() => ({ message: "Request failed" }));
    throw new Error(body.message ?? "Request failed");
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  mediaUrl(path: string | null) {
    if (!path) return "";
    if (path.startsWith("http") || path.startsWith("blob:") || path.startsWith("data:")) return path;
    return `${API_URL}${path}`;
  },
  register(input: { email: string; username: string; displayName: string; password: string }) {
    return request<{ verificationRequired: true; email: string }>("/auth/register", { method: "POST", body: JSON.stringify(input) });
  },
  verifyEmail(input: { email: string; code: string }) {
    return request<Session>("/auth/verify", { method: "POST", body: JSON.stringify(input) });
  },
  resendCode(email: string) {
    return request<{ verificationRequired: true; email: string }>("/auth/resend", { method: "POST", body: JSON.stringify({ email }) });
  },
  login(input: { emailOrUsername: string; password: string }) {
    return request<Session>("/auth/login", { method: "POST", body: JSON.stringify(input) });
  },
  getKeys(token: string) {
    return request<{ keys: { publicKey: string; encryptedPrivateKey: string; keySalt: string; keyIv: string } | null }>("/users/keys", {}, token);
  },
  saveKeys(token: string, input: { publicKey: string; encryptedPrivateKey: string; keySalt: string; keyIv: string }) {
    return request<{ ok: true }>("/users/keys", { method: "PUT", body: JSON.stringify(input) }, token);
  },
  me(token: string) {
    return request<{ user: User }>("/auth/me", {}, token);
  },
  updateProfile(token: string, input: Partial<Pick<User, "displayName" | "bio" | "avatarUrl">>) {
    return request<{ user: User }>("/users/me", { method: "PATCH", body: JSON.stringify(input) }, token);
  },
  searchUsers(token: string, query: string) {
    return request<{ users: User[] }>(`/users/search?q=${encodeURIComponent(query)}`, {}, token);
  },
  friends(token: string) {
    return request<{ friends: User[] }>("/friends", {}, token);
  },
  friendRequests(token: string) {
    return request<{ requests: FriendRequest[] }>("/friends/requests", {}, token);
  },
  sendFriendRequest(token: string, userId: string) {
    return request(`/friends/${userId}/request`, { method: "POST" }, token);
  },
  acceptFriendRequest(token: string, requestId: string) {
    return request<{ conversationId: string }>(`/friends/requests/${requestId}/accept`, { method: "POST" }, token);
  },
  declineFriendRequest(token: string, requestId: string) {
    return request(`/friends/requests/${requestId}/decline`, { method: "POST" }, token);
  },
  conversations(token: string) {
    return request<{ conversations: Conversation[] }>("/conversations", {}, token);
  },
  createConversation(token: string, input: { type: "GROUP" | "CHANNEL"; name: string; description?: string; memberIds: string[] }) {
    return request<{ conversation: Conversation }>("/conversations", { method: "POST", body: JSON.stringify(input) }, token);
  },
  updateConversation(token: string, conversationId: string, input: { name?: string; description?: string; memberIds?: string[] }) {
    return request<{ conversation: Conversation }>(`/conversations/${conversationId}`, { method: "PATCH", body: JSON.stringify(input) }, token);
  },
  messages(token: string, conversationId: string) {
    return request<{ messages: Message[] }>(`/conversations/${conversationId}/messages`, {}, token);
  },
  sendMessage(token: string, conversationId: string, body: string, scheduledFor?: string, encrypted?: boolean, replyToId?: string) {
    return request<{ message: Message }>(
      `/conversations/${conversationId}/messages`,
      { method: "POST", body: JSON.stringify({ body, scheduledFor, encrypted, replyToId }) },
      token
    );
  },
  pinMessage(token: string, conversationId: string, messageId: string) {
    return request<{ message: Message }>(`/conversations/${conversationId}/messages/${messageId}/pin`, { method: "POST" }, token);
  },
  pins(token: string, conversationId: string) {
    return request<{ pins: Message[] }>(`/conversations/${conversationId}/pins`, {}, token);
  },
  sendMedia(token: string, conversationId: string, file: File, caption: string, scheduledFor?: string) {
    const body = new FormData();
    body.append("file", file);
    body.append("caption", caption);
    if (scheduledFor) body.append("scheduledFor", scheduledFor);
    return request<{ message: Message }>(`/conversations/${conversationId}/media`, { method: "POST", body }, token);
  },
  editMessage(token: string, conversationId: string, messageId: string, body: string) {
    return request<{ message: Message }>(
      `/conversations/${conversationId}/messages/${messageId}`,
      { method: "PATCH", body: JSON.stringify({ body }) },
      token
    );
  },
  deleteMessage(token: string, conversationId: string, messageId: string) {
    return request<{ message: Message }>(`/conversations/${conversationId}/messages/${messageId}`, { method: "DELETE" }, token);
  },
  react(token: string, conversationId: string, messageId: string, emoji: string) {
    return request<{ message: Message }>(
      `/conversations/${conversationId}/messages/${messageId}/reactions`,
      { method: "POST", body: JSON.stringify({ emoji }) },
      token
    );
  },
  removeReaction(token: string, conversationId: string, messageId: string, emoji: string) {
    return request<{ message: Message }>(
      `/conversations/${conversationId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
      { method: "DELETE" },
      token
    );
  },
  mediaGallery(token: string, conversationId: string) {
    return request<{ media: Message[] }>(`/conversations/${conversationId}/media`, {}, token);
  },
  globalSearch(token: string, query: string) {
    return request<GlobalSearch>(`/conversations/search?q=${encodeURIComponent(query)}`, {}, token);
  },
  notifications(token: string) {
    return request<{ notifications: Notification[]; unread: number }>("/notifications", {}, token);
  },
  markNotificationsRead(token: string) {
    return request<void>("/notifications/read", { method: "POST" }, token);
  },
  iceServers(token: string) {
    return request<{ iceServers: RTCIceServer[] }>("/calls/ice", {}, token);
  },
  callHistory(token: string, conversationId?: string) {
    const query = conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : "";
    return request<{ calls: CallRecord[] }>(`/calls${query}`, {}, token);
  },
  callStats(token: string) {
    return request<CallStats>("/calls/stats", {}, token);
  },
  pushPublicKey() {
    return request<{ key: string | null }>("/push/public-key");
  },
  pushSubscribe(token: string, subscription: unknown) {
    return request<{ ok: true }>("/push/subscribe", { method: "POST", body: JSON.stringify(subscription) }, token);
  },
  pushUnsubscribe(token: string, endpoint: string) {
    return request<void>("/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint }) }, token);
  },
  uploadRecording(token: string, callId: string, blob: Blob) {
    const body = new FormData();
    const extension = blob.type.includes("mp4") ? "mp4" : "webm";
    body.append("file", new File([blob], `call-${callId}.${extension}`, { type: blob.type || "video/webm" }));
    return request<{ recordingUrl: string }>(`/calls/${callId}/recording`, { method: "POST", body }, token);
  }
};
