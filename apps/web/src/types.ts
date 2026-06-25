export type User = {
  id: string;
  username: string;
  displayName: string;
  bio: string;
  avatarUrl: string | null;
  role?: "OWNER" | "ADMIN" | "MEMBER";
  friendshipStatus?: "PENDING" | "ACCEPTED" | "DECLINED" | "BLOCKED" | null;
  lastDeliveredAt?: string | null;
  lastReadAt?: string | null;
  publicKey?: string | null;
  online?: boolean;
  lastSeenAt?: string | null;
};

export type PresenceUpdate = { userId: string; online: boolean; lastSeenAt?: string | null };

export type ReceiptUpdate = {
  conversationId: string;
  userId: string;
  lastDeliveredAt?: string | null;
  lastReadAt?: string | null;
};

export type MessageReaction = {
  id: string;
  messageId: string;
  userId: string;
  emoji: string;
  createdAt: string;
  user: User;
};

export type Message = {
  id: string;
  conversationId: string;
  senderId: string;
  type: "TEXT" | "IMAGE" | "VIDEO" | "VOICE";
  body: string;
  mediaUrl: string | null;
  originalMediaUrl: string | null;
  storageProvider: string;
  mediaMime: string | null;
  mediaSize: number | null;
  editedAt: string | null;
  deletedAt: string | null;
  scheduledFor: string | null;
  encrypted?: boolean;
  replyToId?: string | null;
  replyTo?: Message | null;
  pinnedAt?: string | null;
  deliveredAt: string | null;
  createdAt: string;
  sender: User;
  reactions: MessageReaction[];
  pending?: boolean;
};

export type Conversation = {
  id: string;
  type: "DIRECT" | "GROUP" | "CHANNEL";
  name: string | null;
  description: string;
  ownerId: string | null;
  members: User[];
  lastMessage: Message | null;
};

export type FriendRequest = {
  id: string;
  user: User;
};

export type Notification = {
  id: string;
  type: "MESSAGE" | "REACTION" | "SCHEDULED" | "SYSTEM";
  title: string;
  body: string;
  conversationId: string | null;
  messageId: string | null;
  readAt: string | null;
  createdAt: string;
};

export type GlobalSearch = {
  messages: Message[];
  files: Message[];
  conversations: Conversation[];
};

export type CallType = "AUDIO" | "VIDEO";
export type CallStatusValue = "RINGING" | "ONGOING" | "ENDED" | "MISSED" | "DECLINED" | "FAILED";

export type IncomingCall = {
  id: string;
  conversationId: string;
  type: CallType;
  caller: User;
};

export type CallParticipant = {
  userId: string;
  user: User;
  joinedAt: string | null;
  leftAt: string | null;
};

export type CallRecord = {
  id: string;
  conversationId: string;
  callerId: string;
  type: CallType;
  status: CallStatusValue;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  durationSec: number;
  recordingUrl: string | null;
  caller: User;
  participants: CallParticipant[];
};

export type CallStats = {
  total: number;
  completed: number;
  missed: number;
  declined: number;
  video: number;
  audio: number;
  totalDurationSec: number;
  avgDurationSec: number;
};
