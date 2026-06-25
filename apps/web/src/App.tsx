import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { io, type Socket } from "socket.io-client";
import {
  Archive,
  Ban,
  Bell,
  BellOff,
  CalendarClock,
  Camera,
  Inbox,
  Check,
  CheckCheck,
  ChevronDown,
  Download,
  Forward,
  Hash,
  Images,
  KeyRound,
  Lock,
  LogOut,
  Menu,
  MessageCircle,
  Mic,
  Moon,
  MoreVertical,
  Paperclip,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Phone,
  PhoneCall,
  Pin,
  Plus,
  Reply,
  Search,
  Send,
  Smile,
  Sun,
  SwitchCamera,
  Trash2,
  Upload,
  UserMinus,
  UserPlus,
  Users,
  Video,
  X
} from "lucide-react";
import { api, type Session } from "./api";
import { CallProvider, useCall } from "./call";
import { clearLocalPrivateKey, decryptText, deriveConversationKey, encryptText, loadLocalPrivateKey, rewrapLocalPrivateKey, setupKeys, WrongPasswordError } from "./e2ee";
import { ensureNotificationPermission, playSound, showNotification, unlockAudio } from "./notify";
import { registerPush } from "./push";
// Code-split: the prayer-times panel pulls in the `adhan` library, which is
// dead weight for the initial chat load. Loaded lazily in the sidebar.
const IslamicPanel = lazy(() => import("./islamic").then((m) => ({ default: m.IslamicPanel })));
import type { CallRecord, CallStats, Conversation, FriendRequest, GlobalSearch, Message, PresenceUpdate, ReceiptUpdate, User } from "./types";

const EMOJIS = ["👍", "❤️", "😂", "🔥", "🥰", "😮", "😢", "😡", "🎉", "👏", "🙏", "💯", "😎", "🤔", "👀", "✅"];

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL ?? "http://localhost:4000";
const savedTheme = localStorage.getItem("nexus-theme");

type EncryptionController = {
  ready: boolean;
  canEncrypt: (conversation?: Conversation | null) => boolean;
  encryptForConversation: (conversation: Conversation, text: string) => Promise<{ body: string; encrypted: boolean }>;
  decryptForConversation: (conversation: Conversation, message: Message) => Promise<string | null>;
};

const EncryptionContext = createContext<EncryptionController>({
  ready: false,
  canEncrypt: () => false,
  encryptForConversation: async (_conversation, text) => ({ body: text, encrypted: false }),
  decryptForConversation: async (_conversation, message) => message.body
});

function useEncryption() {
  return useContext(EncryptionContext);
}

function peerWithKey(conversation: Conversation, currentUserId: string) {
  if (conversation.type !== "DIRECT") return null;
  const peer = conversation.members.find((member) => member.id !== currentUserId);
  return peer?.publicKey ? peer : null;
}

const FOCUSABLE = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

// Shared modal wrapper: focus trap, Escape-to-close, click-outside, and focus
// restoration. Replaces the bare `.dialog-backdrop` divs so every dialog is
// keyboard-accessible and behaves like a native sheet on mobile.
function ModalShell({
  onClose,
  children,
  className,
  dismissable = true
}: {
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
  dismissable?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const visibleFocusables = () =>
      node ? Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null) : [];

    // Respect a child's autoFocus (its effect already ran); otherwise focus the first control.
    if (node && !node.contains(document.activeElement)) {
      visibleFocusables()[0]?.focus();
    }

    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && dismissable) {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = visibleFocusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      previouslyFocused?.focus?.();
    };
  }, [onClose, dismissable]);

  return (
    <div
      ref={ref}
      className={`dialog-backdrop ${className ?? ""}`}
      role="dialog"
      aria-modal="true"
      onMouseDown={(event) => {
        if (dismissable && event.target === event.currentTarget) onClose();
      }}
    >
      {children}
    </div>
  );
}

export function App() {
  const [session, setSession] = useState<Session | null>(() => {
    const saved = localStorage.getItem("nexus-session");
    return saved ? (JSON.parse(saved) as Session) : null;
  });
  const [theme, setTheme] = useState(savedTheme === "light" ? "light" : "dark");
  const token = session?.token;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("nexus-theme", theme);
  }, [theme]);

  // Keep the app height locked to the *visual* viewport so the on-screen
  // keyboard pushes the composer up instead of hiding it (iOS Safari / Android).
  // `dvh` alone doesn't shrink for the keyboard, so we track visualViewport.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const apply = () => {
      root.style.setProperty("--app-h", `${Math.round(vv.height)}px`);
      // Offset for when the keyboard scrolls the visual viewport off the top.
      root.style.setProperty("--vv-offset", `${Math.round(vv.offsetTop)}px`);
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      root.style.removeProperty("--app-h");
      root.style.removeProperty("--vv-offset");
    };
  }, []);

  useEffect(() => {
    if (!token) return;
    // Validate the saved session; a failure (e.g. 401) triggers a clean logout
    // via the global handler below, so swallow the rejection here.
    void api
      .me(token)
      .then(({ user }) => setSession((current) => (current ? { ...current, user } : current)))
      .catch(() => {});
  }, [token]);

  useEffect(() => {
    if (session) localStorage.setItem("nexus-session", JSON.stringify(session));
  }, [session]);

  // Any authenticated request that gets a 401 dispatches this — log out cleanly.
  useEffect(() => {
    const onUnauthorized = () => {
      localStorage.removeItem("nexus-session");
      setSession(null);
    };
    window.addEventListener("nexus-unauthorized", onUnauthorized);
    return () => window.removeEventListener("nexus-unauthorized", onUnauthorized);
  }, []);

  function logout() {
    localStorage.removeItem("nexus-session");
    setSession(null);
  }

  if (!session) {
    return <AuthScreen onSession={setSession} theme={theme} onThemeChange={setTheme} />;
  }

  return (
    <EncryptionProvider token={session.token} user={session.user}>
      <Messenger session={session} setSession={setSession} onLogout={logout} theme={theme} onThemeChange={setTheme} />
    </EncryptionProvider>
  );
}

function AuthScreen({
  onSession,
  theme,
  onThemeChange
}: {
  onSession: (session: Session) => void;
  theme: string;
  onThemeChange: (theme: string) => void;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [step, setStep] = useState<"credentials" | "verify" | "forgot" | "reset">("credentials");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [loading, setLoading] = useState(false);
  const [pendingEmail, setPendingEmail] = useState("");
  const [pendingPassword, setPendingPassword] = useState("");

  // Restore/generate this device's E2EE keys using the password the user just
  // typed. Failures are non-fatal — the in-app unlock prompt can recover later.
  async function provisionKeys(session: Session, password: string) {
    try {
      await setupKeys(session.token, session.user.id, password);
    } catch (err) {
      console.warn("Encryption key setup deferred:", err);
    }
  }

  function switchMode(next: "login" | "register") {
    setMode(next);
    setStep("credentials");
    setError("");
    setInfo("");
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setInfo("");
    setLoading(true);
    const data = new FormData(event.currentTarget);
    try {
      if (mode === "login") {
        const password = String(data.get("password"));
        const result = await api.login({ emailOrUsername: String(data.get("identity")), password });
        await provisionKeys(result, password);
        onSession(result);
      } else {
        const email = String(data.get("email"));
        const password = String(data.get("password"));
        await api.register({
          email,
          username: String(data.get("username")),
          displayName: String(data.get("displayName")),
          password
        });
        setPendingEmail(email);
        setPendingPassword(password);
        setStep("verify");
        setInfo(`We sent a 6-digit code to ${email}.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to continue");
    } finally {
      setLoading(false);
    }
  }

  async function submitVerify(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setInfo("");
    setLoading(true);
    const data = new FormData(event.currentTarget);
    try {
      const result = await api.verifyEmail({ email: pendingEmail, code: String(data.get("code")).trim() });
      await provisionKeys(result, pendingPassword);
      onSession(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid code");
    } finally {
      setLoading(false);
    }
  }

  async function resend() {
    setError("");
    try {
      await api.resendCode(pendingEmail);
      setInfo(`A new code was sent to ${pendingEmail}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to resend");
    }
  }

  async function submitForgot(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setInfo("");
    setLoading(true);
    const email = String(new FormData(event.currentTarget).get("email"));
    try {
      await api.forgotPassword(email);
      setPendingEmail(email);
      setStep("reset");
      setInfo(`If an account exists for ${email}, a reset code is on its way.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to send reset code");
    } finally {
      setLoading(false);
    }
  }

  async function submitReset(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setLoading(true);
    const data = new FormData(event.currentTarget);
    try {
      const result = await api.resetPassword({
        email: pendingEmail,
        code: String(data.get("code")).trim(),
        newPassword: String(data.get("password"))
      });
      // The reset clears E2EE keys server-side; drop any stale local key so
      // provisioning regenerates a fresh identity under the new password.
      await clearLocalPrivateKey(result.user.id);
      await provisionKeys(result, String(data.get("password")));
      onSession(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to reset password");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="auth-page">
      <button className="icon-button theme-float" onClick={() => onThemeChange(theme === "dark" ? "light" : "dark")}>
        {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
      </button>
      <section className="auth-stage">
        <div className="brand-panel">
          <div className="brand-mark">N</div>
          <h1>Nexus</h1>
          <p>Secure private messaging with rich media and realtime presence-ready foundations.</p>
          <div className="signal-grid">
            <span>Encrypted sessions</span>
            <span>Realtime delivery</span>
            <span>Media sharing</span>
            <span>Responsive UI</span>
          </div>
        </div>
        {step === "verify" ? (
          <form className="auth-card" onSubmit={submitVerify}>
            <h2>Verify your email</h2>
            <p className="muted">Enter the 6-digit code we emailed to finish creating your account.</p>
            <label>
              Verification code
              <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} placeholder="000000" required autoFocus />
            </label>
            {info && <p className="status">{info}</p>}
            {error && <p className="error">{error}</p>}
            <button className="primary-button" disabled={loading}>
              {loading ? "Verifying..." : "Verify & enter"}
            </button>
            <div className="verify-actions">
              <button type="button" className="link-button" onClick={resend}>Resend code</button>
              <button type="button" className="link-button" onClick={() => switchMode("register")}>Start over</button>
            </div>
          </form>
        ) : step === "forgot" ? (
          <form className="auth-card" onSubmit={submitForgot}>
            <h2>Reset your password</h2>
            <p className="muted">Enter your account email and we'll send a 6-digit reset code.</p>
            <label>
              Email
              <input name="email" type="email" autoComplete="email" required autoFocus />
            </label>
            {info && <p className="status">{info}</p>}
            {error && <p className="error">{error}</p>}
            <button className="primary-button" disabled={loading}>{loading ? "Sending..." : "Send reset code"}</button>
            <button type="button" className="link-button" onClick={() => { setStep("credentials"); setError(""); setInfo(""); }}>Back to login</button>
          </form>
        ) : step === "reset" ? (
          <form className="auth-card" onSubmit={submitReset}>
            <h2>Enter reset code</h2>
            <p className="muted">Enter the code we emailed and choose a new password. Resetting clears encrypted message history on this account.</p>
            <label>
              Reset code
              <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} placeholder="000000" required autoFocus />
            </label>
            <label>
              New password
              <input name="password" type="password" autoComplete="new-password" minLength={10} required />
            </label>
            {info && <p className="status">{info}</p>}
            {error && <p className="error">{error}</p>}
            <button className="primary-button" disabled={loading}>{loading ? "Resetting..." : "Reset & enter"}</button>
            <button type="button" className="link-button" onClick={() => { setStep("forgot"); setError(""); }}>Use a different email</button>
          </form>
        ) : (
          <form className="auth-card" onSubmit={submit}>
            <div className="segmented">
              <button type="button" className={mode === "login" ? "active" : ""} onClick={() => switchMode("login")}>
                Login
              </button>
              <button type="button" className={mode === "register" ? "active" : ""} onClick={() => switchMode("register")}>
                Register
              </button>
            </div>
            <h2>{mode === "login" ? "Welcome back" : "Create your profile"}</h2>
            {mode === "register" && (
              <>
                <label>
                  Email
                  <input name="email" type="email" autoComplete="email" required />
                </label>
                <label>
                  Username
                  <input name="username" autoComplete="username" minLength={3} required />
                </label>
                <label>
                  Display name
                  <input name="displayName" autoComplete="name" minLength={2} required />
                </label>
              </>
            )}
            {mode === "login" && (
              <label>
                Email or username
                <input name="identity" autoComplete="username" required />
              </label>
            )}
            <label>
              Password
              <input name="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={10} required />
            </label>
            {error && <p className="error">{error}</p>}
            <button className="primary-button" disabled={loading}>
              {loading ? "Working..." : mode === "login" ? "Enter Nexus" : "Create account"}
            </button>
            {mode === "login" && (
              <button type="button" className="link-button" onClick={() => { setStep("forgot"); setError(""); setInfo(""); }}>
                Forgot password?
              </button>
            )}
          </form>
        )}
      </section>
    </main>
  );
}

function Messenger({
  session,
  setSession,
  onLogout,
  theme,
  onThemeChange
}: {
  session: Session;
  setSession: React.Dispatch<React.SetStateAction<Session | null>>;
  onLogout: () => void;
  theme: string;
  onThemeChange: (theme: string) => void;
}) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<User[]>([]);
  const [friends, setFriends] = useState<User[]>([]);
  const [requests, setRequests] = useState<FriendRequest[]>([]);
  const [profileOpen, setProfileOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [globalQuery, setGlobalQuery] = useState("");
  const [globalResults, setGlobalResults] = useState<GlobalSearch>({ messages: [], files: [], conversations: [] });
  const [mobileListOpen, setMobileListOpen] = useState(true);
  const [status, setStatus] = useState("");
  const [callHistoryOpen, setCallHistoryOpen] = useState(false);
  const [pinnedOpen, setPinnedOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [forwardSource, setForwardSource] = useState<Message | null>(null);
  const [convMenuOpen, setConvMenuOpen] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [typing, setTyping] = useState<{ conversationId: string; name: string } | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const activeConversationRef = useRef("");
  const typingTimerRef = useRef<number | null>(null);
  const touchStartRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;

  // Kept in refs so the long-lived socket handler can decrypt a freshly-arrived
  // message for its notification without being re-created on every change.
  const { decryptForConversation } = useEncryption();
  const decryptRef = useRef(decryptForConversation);
  const conversationsRef = useRef<Conversation[]>([]);
  useEffect(() => {
    decryptRef.current = decryptForConversation;
  }, [decryptForConversation]);
  useEffect(() => {
    conversationsRef.current = conversations;
  });

  // Swipe to open the conversation drawer from the left edge, or close it by
  // swiping left — only on mobile widths, ignoring vertical scroll gestures.
  function onShellTouchStart(event: React.TouchEvent) {
    const touch = event.touches[0];
    touchStartRef.current = { x: touch.clientX, y: touch.clientY, t: Date.now() };
  }
  function onShellTouchEnd(event: React.TouchEvent) {
    const start = touchStartRef.current;
    touchStartRef.current = null;
    if (!start || window.innerWidth > 900) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Math.abs(dx) < 60 || Math.abs(dy) > 50 || Date.now() - start.t > 600) return;
    if (dx > 0 && start.x < 32 && !mobileListOpen) setMobileListOpen(true);
    else if (dx < 0 && mobileListOpen) setMobileListOpen(false);
  }

  // Merge a presence change into both conversation members and the friends list.
  const applyPresence = useCallback((p: PresenceUpdate) => {
    const patch = (u: User) => (u.id === p.userId ? { ...u, online: p.online, lastSeenAt: p.lastSeenAt ?? u.lastSeenAt ?? null } : u);
    setConversations((current) => current.map((c) => ({ ...c, members: c.members.map(patch) })));
    setFriends((current) => current.map(patch));
  }, []);

  const selected = conversations.find((conversation) => conversation.id === selectedId) ?? conversations[0];
  const peer = selected?.members.find((member) => member.id !== session.user.id) ?? selected?.members[0];
  const selectedTitle = selected ? conversationTitle(selected, session.user.id) : "";

  const loadConversations = useCallback(async () => {
    const { conversations } = await api.conversations(session.token);
    setConversations(conversations);
  }, [session.token]);

  const loadFriends = useCallback(async () => {
    const { friends } = await api.friends(session.token);
    setFriends(friends);
  }, [session.token]);

  const loadRequests = useCallback(async () => {
    const { requests } = await api.friendRequests(session.token);
    setRequests(requests);
  }, [session.token]);

  const refresh = useCallback(async () => {
    await Promise.all([loadConversations(), loadFriends(), loadRequests()]);
  }, [loadConversations, loadFriends, loadRequests]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!selectedId && conversations[0]) setSelectedId(conversations[0].id);
  }, [conversations, selectedId]);

  useEffect(() => {
    // Connect straight over WebSocket — skip the HTTP long-poll handshake +
    // upgrade round-trip for a faster connect and lower per-event overhead.
    const socket = io(SOCKET_URL, { auth: { token: session.token }, transports: ["websocket"] });
    socketRef.current = socket;
    setSocket(socket);
    // A rejected socket handshake means the token is invalid — trigger the same
    // global logout as a 401 rather than retrying forever with no realtime.
    socket.on("connect_error", (err) => {
      if (err.message === "Invalid session" || err.message === "Authentication required") {
        window.dispatchEvent(new Event("nexus-unauthorized"));
      }
    });
    socket.on("message:new", (message: Message) => {
      const isActive = message.conversationId === activeConversationRef.current;
      if (isActive) {
        setMessages((current) => (current.some((item) => item.id === message.id) ? current : [...current, message]));
      }
      const mine = message.senderId === session.user.id;
      const convo = conversationsRef.current.find((c) => c.id === message.conversationId);
      const muted = Boolean(convo?.muted);
      if (!mine && !muted) {
        playSound("message");
        // Decrypt the body for the notification so it shows the real text
        // instead of "Encrypted message" (keys are local; falls back if locked).
        void (async () => {
          let preview = previewMessage(message);
          if (convo && message.type === "TEXT" && message.encrypted) {
            try {
              const text = await decryptRef.current(convo, message);
              if (text) preview = text;
            } catch {
              /* keep the locked-message fallback */
            }
          }
          showNotification(message.sender?.displayName ?? "New message", preview || "New message", {
            icon: api.mediaUrl(message.sender?.avatarUrl ?? null) || undefined,
            tag: message.conversationId,
            onClick: () => {
              setSelectedId(message.conversationId);
              setMobileListOpen(false);
            }
          });
        })();
      }
      // If the new message lands in the conversation we're looking at, mark it read.
      if (isActive && !mine) {
        socket.emit("conversation:read", message.conversationId);
      }
      // Patch the conversation list locally (update preview, bump unread, move to
      // top) instead of refetching the whole list on every single message.
      setConversations((current) => {
        const index = current.findIndex((c) => c.id === message.conversationId);
        if (index === -1) {
          void loadConversations(); // a conversation we don't know about (or was hidden)
          return current;
        }
        const convoItem = current[index];
        const unreadCount = mine || isActive ? convoItem.unreadCount ?? 0 : (convoItem.unreadCount ?? 0) + 1;
        const updated = { ...convoItem, lastMessage: message, unreadCount: isActive ? 0 : unreadCount };
        return [updated, ...current.filter((_, i) => i !== index)];
      });
    });
    socket.on("message:updated", (message: Message) => {
      setMessages((current) => current.map((item) => (item.id === message.id ? message : item)));
      // Only touch the list if the edited/deleted message is the one previewed.
      setConversations((current) =>
        current.map((c) => (c.lastMessage?.id === message.id ? { ...c, lastMessage: message } : c))
      );
    });
    socket.on("presence:update", (p: PresenceUpdate) => applyPresence(p));
    socket.on("friend:request", () => {
      void loadRequests();
      playSound("message");
      showNotification("Friend request", "Someone wants to connect on Nexus");
    });
    socket.on("friend:accepted", ({ conversationId }: { conversationId: string }) => {
      void refresh();
      if (conversationId) setSelectedId(conversationId);
    });
    socket.on("typing:start", ({ conversationId, user }: { conversationId: string; user: User }) => {
      if (user.id === session.user.id) return;
      setTyping({ conversationId, name: user.displayName });
    });
    socket.on("typing:stop", ({ conversationId }: { conversationId: string }) => {
      setTyping((current) => (current?.conversationId === conversationId ? null : current));
    });
    socket.on("receipt:update", (receipt: ReceiptUpdate) => {
      setConversations((current) =>
        current.map((conversation) =>
          conversation.id === receipt.conversationId
            ? {
                ...conversation,
                members: conversation.members.map((member) =>
                  member.id === receipt.userId
                    ? {
                        ...member,
                        lastDeliveredAt: receipt.lastDeliveredAt ?? member.lastDeliveredAt ?? null,
                        lastReadAt: receipt.lastReadAt ?? member.lastReadAt ?? null
                      }
                    : member
                )
              }
            : conversation
        )
      );
    });
    socket.on("friend:removed", ({ userId }: { userId: string }) => {
      setFriends((current) => current.filter((friend) => friend.id !== userId));
    });
    socket.on("conversation:removed", ({ conversationId }: { conversationId: string }) => {
      setConversations((current) => current.filter((conversation) => conversation.id !== conversationId));
      setSelectedId((current) => (current === conversationId ? "" : current));
    });
    socket.on("conversation:updated", (conversation: Conversation) => {
      setConversations((current) => current.map((item) => (item.id === conversation.id ? { ...item, ...conversation } : item)));
    });
    return () => {
      socket.disconnect();
      setSocket(null);
    };
  }, [loadConversations, loadRequests, refresh, applyPresence, session.token, session.user.id]);

  useEffect(() => {
    ensureNotificationPermission();
    unlockAudio();
    void registerPush(session.token);
  }, [session.token]);

  // Lock the document to the (keyboard-resized) viewport so there is never any
  // scrollable space below the latest message — the chat fills exactly the area
  // above the keyboard, like a native messenger. Only while the chat is mounted,
  // so the auth screen stays scrollable on short devices.
  useEffect(() => {
    document.documentElement.classList.add("messenger-active");
    document.body.classList.add("messenger-active");
    return () => {
      document.documentElement.classList.remove("messenger-active");
      document.body.classList.remove("messenger-active");
    };
  }, []);

  // Close the mobile conversation drawer with Escape.
  useEffect(() => {
    if (!mobileListOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileListOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileListOpen]);

  useEffect(() => {
    if (!selected?.id) return;
    const conversationId = selected.id;
    activeConversationRef.current = conversationId;
    socketRef.current?.emit("conversation:join", conversationId);
    socketRef.current?.emit("conversation:read", conversationId);
    // Opening a chat clears its unread badge locally (the server is told via the
    // conversation:read emit above).
    setConversations((current) =>
      current.map((conversation) => (conversation.id === conversationId ? { ...conversation, unreadCount: 0 } : conversation))
    );
    // Guard against out-of-order responses when switching chats quickly: only
    // apply messages that still belong to the conversation in view.
    let active = true;
    setHasMore(false);
    void api.messages(session.token, conversationId).then(({ messages, hasMore }) => {
      if (active && activeConversationRef.current === conversationId) {
        setMessages(messages);
        setHasMore(hasMore);
      }
    });
    setMobileListOpen(false);
    return () => {
      active = false;
      activeConversationRef.current = "";
    };
  }, [selected?.id, session.token]);

  // Page backwards through history for infinite scroll-up. Reads the current
  // messages from a ref so its identity stays stable across renders.
  const loadOlder = useCallback(async () => {
    const conversationId = activeConversationRef.current;
    const oldest = messagesRef.current[0];
    if (!conversationId || !oldest) return;
    const { messages: older, hasMore: more } = await api.messages(session.token, conversationId, oldest.id);
    if (activeConversationRef.current !== conversationId) return;
    setHasMore(more);
    if (older.length > 0) {
      setMessages((current) => {
        const known = new Set(current.map((message) => message.id));
        const fresh = older.filter((message) => !known.has(message.id));
        return fresh.length > 0 ? [...fresh, ...current] : current;
      });
    }
  }, [session.token]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      if (search.trim().length >= 2) {
        void api.searchUsers(session.token, search).then(({ users }) => setResults(users));
      } else {
        setResults([]);
      }
    }, 250);
    return () => window.clearTimeout(handle);
  }, [search, session.token]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      if (globalQuery.trim().length >= 2) {
        void api.globalSearch(session.token, globalQuery).then(setGlobalResults);
      } else {
        setGlobalResults({ messages: [], files: [], conversations: [] });
      }
    }, 260);
    return () => window.clearTimeout(handle);
  }, [globalQuery, session.token]);

  async function addFriend(userId: string) {
    try {
      await api.sendFriendRequest(session.token, userId);
      setStatus("Friend request sent");
      setResults((users) => users.filter((user) => user.id !== userId));
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Unable to send request");
    }
  }

  async function acceptRequest(requestId: string) {
    const { conversationId } = await api.acceptFriendRequest(session.token, requestId);
    setSelectedId(conversationId);
    await refresh();
  }

  async function declineRequest(requestId: string) {
    await api.declineFriendRequest(session.token, requestId);
    await loadRequests();
  }

  async function createConversation(input: { type: "GROUP" | "CHANNEL"; name: string; description: string; memberIds: string[] }) {
    const { conversation } = await api.createConversation(session.token, input);
    setConversations((current) => [conversation, ...current]);
    setSelectedId(conversation.id);
    setCreateOpen(false);
  }

  // Optimistic send: show the message instantly, then reconcile with the server.
  const addOptimistic = useCallback((message: Message) => {
    setMessages((current) => [...current, message]);
  }, []);
  const settleOptimistic = useCallback((tempId: string, real: Message | null) => {
    setMessages((current) => {
      const without = current.filter((m) => m.id !== tempId);
      if (real && !without.some((m) => m.id === real.id)) return [...without, real];
      return without;
    });
  }, []);

  const emitTyping = useCallback(
    (conversationId: string) => {
      socketRef.current?.emit("typing:start", conversationId);
      if (typingTimerRef.current) window.clearTimeout(typingTimerRef.current);
      typingTimerRef.current = window.setTimeout(() => {
        socketRef.current?.emit("typing:stop", conversationId);
      }, 2200);
    },
    []
  );

  async function togglePin(message: Message) {
    const { message: updated } = await api.pinMessage(session.token, message.conversationId, message.id);
    setMessages((current) => current.map((m) => (m.id === updated.id ? updated : m)));
  }

  function patchConversation(conversationId: string, patch: Partial<Conversation>) {
    setConversations((current) => current.map((c) => (c.id === conversationId ? { ...c, ...patch } : c)));
  }

  async function toggleMute(conversation: Conversation) {
    setConvMenuOpen(false);
    try {
      if (conversation.muted) {
        await api.unmuteConversation(session.token, conversation.id);
        patchConversation(conversation.id, { muted: false });
      } else {
        await api.muteConversation(session.token, conversation.id);
        patchConversation(conversation.id, { muted: true });
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Unable to update mute");
    }
  }

  async function toggleArchive(conversation: Conversation) {
    setConvMenuOpen(false);
    try {
      if (conversation.archived) {
        await api.unarchiveConversation(session.token, conversation.id);
        patchConversation(conversation.id, { archived: false });
      } else {
        await api.archiveConversation(session.token, conversation.id);
        patchConversation(conversation.id, { archived: true });
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Unable to update archive");
    }
  }

  async function removeConversation(conversation: Conversation) {
    setConvMenuOpen(false);
    const isGroup = conversation.type !== "DIRECT";
    const prompt = isGroup ? "Leave this conversation?" : "Delete this chat? It will reappear if you receive a new message.";
    if (!window.confirm(prompt)) return;
    try {
      await api.deleteConversation(session.token, conversation.id);
      setConversations((current) => current.filter((c) => c.id !== conversation.id));
      setSelectedId((current) => (current === conversation.id ? "" : current));
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Unable to remove conversation");
    }
  }

  async function unfriend(user: User) {
    if (!window.confirm(`Remove ${user.displayName} from your friends?`)) return;
    try {
      await api.removeFriend(session.token, user.id);
      setFriends((current) => current.filter((f) => f.id !== user.id));
      setResults((current) => current.map((u) => (u.id === user.id ? { ...u, friendshipStatus: null, outgoing: false } : u)));
      setStatus("Friend removed");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Unable to remove friend");
    }
  }

  async function cancelRequest(user: User) {
    try {
      await api.removeFriend(session.token, user.id);
      setResults((current) => current.map((u) => (u.id === user.id ? { ...u, friendshipStatus: null, outgoing: false } : u)));
      setStatus("Request canceled");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Unable to cancel request");
    }
  }

  async function blockUser(user: User) {
    if (!window.confirm(`Block ${user.displayName}? They won't be able to message you and will be removed from your friends.`)) return;
    try {
      await api.blockUser(session.token, user.id);
      setFriends((current) => current.filter((f) => f.id !== user.id));
      setResults((current) => current.filter((u) => u.id !== user.id));
      setStatus(`${user.displayName} blocked`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Unable to block user");
    }
  }

  async function doForward(toConversationId: string) {
    if (!forwardSource) return;
    try {
      await api.forwardMessage(session.token, forwardSource.conversationId, forwardSource.id, toConversationId);
      setStatus("Message forwarded");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Unable to forward");
    } finally {
      setForwardSource(null);
    }
  }

  const renderConversationItem = (conversation: Conversation) => {
    const other = conversation.members.find((member) => member.id !== session.user.id) ?? conversation.members[0];
    const title = conversationTitle(conversation, session.user.id);
    return (
      <button
        key={conversation.id}
        className={`conversation-item ${conversation.id === selected?.id ? "active" : ""}`}
        onClick={() => setSelectedId(conversation.id)}
      >
        {conversation.type === "DIRECT" ? <PresenceAvatar user={other} /> : <div className="avatar placeholder">{conversation.type === "CHANNEL" ? <Hash size={18} /> : <Users size={18} />}</div>}
        <span>
          <strong>{title}</strong>
          <small>{conversation.lastMessage ? previewMessage(conversation.lastMessage) : "Say hello"}</small>
        </span>
        <span className="conversation-meta">
          {conversation.muted && <BellOff size={13} className="muted-icon" />}
          {(conversation.unreadCount ?? 0) > 0 && conversation.id !== selected?.id && (
            <span className="unread-badge">{(conversation.unreadCount ?? 0) > 99 ? "99+" : conversation.unreadCount}</span>
          )}
        </span>
      </button>
    );
  };

  const activeConversations = conversations.filter((conversation) => !conversation.archived);
  const archivedConversations = conversations.filter((conversation) => conversation.archived);

  const showTyping = typing && typing.conversationId === selected?.id;

  return (
    <CallProvider socket={socket} self={session.user} token={session.token}>
    <main
      className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}
      onTouchStart={onShellTouchStart}
      onTouchEnd={onShellTouchEnd}
    >
      {sidebarCollapsed && (
        <button className="icon-button sidebar-reveal" onClick={() => setSidebarCollapsed(false)} title="Show panel">
          <PanelLeftOpen size={18} />
        </button>
      )}
      <div
        className={`sidebar-backdrop ${mobileListOpen ? "show" : ""}`}
        onClick={() => setMobileListOpen(false)}
        aria-hidden="true"
      />
      <aside className={`sidebar ${mobileListOpen ? "open" : ""}`}>
        <div className="topbar">
          <div className="identity">
            <Avatar user={session.user} />
            <div>
              <strong>{session.user.displayName}</strong>
              <span>@{session.user.username}</span>
            </div>
          </div>
          <div className="top-actions">
            <button className="icon-button" onClick={() => setSidebarCollapsed(true)} title="Hide panel">
              <PanelLeftClose size={18} />
            </button>
            <button className="icon-button" onClick={() => onThemeChange(theme === "dark" ? "light" : "dark")} title="Toggle theme">
              {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <button className="icon-button" onClick={() => setCreateOpen(true)} title="Create group or channel">
              <Plus size={18} />
            </button>
            <button className="icon-button" onClick={() => setProfileOpen(true)} title="Profile">
              <UserPlus size={18} />
            </button>
            <button className="icon-button" onClick={onLogout} title="Log out">
              <LogOut size={18} />
            </button>
          </div>
        </div>

        <div className="search-box">
          <Search size={18} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search usernames" />
        </div>

        <div className="search-box">
          <Hash size={18} />
          <input value={globalQuery} onChange={(event) => setGlobalQuery(event.target.value)} placeholder="Global search" />
        </div>

        {status && <p className="status">{status}</p>}

        {(globalResults.conversations.length > 0 || globalResults.messages.length > 0 || globalResults.files.length > 0) && (
          <section className="panel">
            <h3>Search</h3>
            {globalResults.conversations.map((conversation) => (
              <button key={conversation.id} className="result-item" onClick={() => setSelectedId(conversation.id)}>
                {conversationTitle(conversation, session.user.id)}
              </button>
            ))}
            {globalResults.messages.slice(0, 4).map((message) => (
              <button key={message.id} className="result-item" onClick={() => setSelectedId(message.conversationId)}>
                {message.body || previewMessage(message)}
              </button>
            ))}
            {globalResults.files.slice(0, 4).map((message) => (
              <button key={message.id} className="result-item" onClick={() => setSelectedId(message.conversationId)}>
                {message.mediaMime ?? "Shared file"} · {formatBytes(message.mediaSize)}
              </button>
            ))}
          </section>
        )}

        {results.length > 0 && (
          <section className="panel">
            <h3>People</h3>
            {results.map((user) => {
              const status = user.friendshipStatus;
              const primary =
                status === "ACCEPTED" ? (
                  <span className="pill-muted">Friends</span>
                ) : status === "PENDING" && user.outgoing ? (
                  <button className="icon-button" title="Cancel request" onClick={() => void cancelRequest(user)}><X size={17} /></button>
                ) : status === "PENDING" ? (
                  <span className="pill-muted">Requested you</span>
                ) : (
                  <button className="icon-button" title="Add friend" onClick={() => addFriend(user.id)}><UserPlus size={17} /></button>
                );
              return (
                <UserRow
                  key={user.id}
                  user={user}
                  action={
                    <div className="inline-actions">
                      {primary}
                      <KebabMenu items={[{ label: "Block", icon: <Ban size={15} />, danger: true, onClick: () => void blockUser(user) }]} />
                    </div>
                  }
                />
              );
            })}
          </section>
        )}

        {requests.length > 0 && (
          <section className="panel">
            <h3>Requests</h3>
            {requests.map((request) => (
              <UserRow
                key={request.id}
                user={request.user}
                action={
                  <div className="inline-actions">
                    <button className="icon-button success" onClick={() => acceptRequest(request.id)}><Check size={17} /></button>
                    <button className="icon-button danger" onClick={() => declineRequest(request.id)}><X size={17} /></button>
                  </div>
                }
              />
            ))}
          </section>
        )}

        <section className="panel conversations">
          <h3>Messages</h3>
          {conversations.length === 0 && <p className="empty">Add a friend to open your first private chat.</p>}
          {activeConversations.map(renderConversationItem)}
          {archivedConversations.length > 0 && (
            <>
              <button className="archived-toggle" onClick={() => setShowArchived((value) => !value)} aria-expanded={showArchived}>
                <Archive size={14} /> Archived ({archivedConversations.length})
                <ChevronDown size={14} className={showArchived ? "rot" : ""} />
              </button>
              {showArchived && archivedConversations.map(renderConversationItem)}
            </>
          )}
        </section>

        <Suspense fallback={null}>
          <IslamicPanel />
        </Suspense>

        <section className="panel friends">
          <h3>Friends</h3>
          {friends.length === 0 && <p className="empty">No friends yet. Search above to connect.</p>}
          {friends.map((friend) => (
            <UserRow
              key={friend.id}
              user={friend}
              action={
                <KebabMenu
                  items={[
                    { label: "Remove friend", icon: <UserMinus size={15} />, onClick: () => void unfriend(friend) },
                    { label: "Block", icon: <Ban size={15} />, danger: true, onClick: () => void blockUser(friend) }
                  ]}
                />
              }
            />
          ))}
        </section>
      </aside>

      <section className="chat">
        <header className="chat-header">
          <button className="icon-button mobile-menu" onClick={() => setMobileListOpen(true)}>
            <Menu size={20} />
          </button>
          {peer ? (
            <div className="identity">
              {selected?.type === "DIRECT" ? <PresenceAvatar user={peer} /> : <div className="avatar placeholder">{selected?.type === "CHANNEL" ? <Hash size={18} /> : <Users size={18} />}</div>}
              <div>
                <strong>{selectedTitle}</strong>
                <span>
                  {showTyping ? (
                    <em className="typing-status">{typing?.name} is typing…</em>
                  ) : selected?.type === "DIRECT" ? (
                    peer.online ? "Active now" : peer.lastSeenAt ? `Last seen ${formatLastSeen(peer.lastSeenAt)}` : `@${peer.username}`
                  ) : (
                    `${selected?.members.length ?? 0} members`
                  )}
                  <EncryptionBadge conversation={selected} />
                </span>
              </div>
            </div>
          ) : (
            <div className="identity">
              <div className="avatar placeholder"><MessageCircle size={18} /></div>
              <div>
                <strong>No conversation selected</strong>
                <span>Search for a friend to begin</span>
              </div>
            </div>
          )}
          <div className="chat-tools">
            <button className="icon-button" title="Pinned messages" onClick={() => setPinnedOpen(true)}><Pin size={18} /></button>
            <button className="icon-button" title="Media gallery" onClick={() => setGalleryOpen(true)}><Images size={18} /></button>
            <CallButtons selected={selected} peer={peer} />
            <button className="icon-button" title="Call history" onClick={() => setCallHistoryOpen(true)}><PhoneCall size={18} /></button>
            {selected && (
              <div className="menu-wrap">
                <button className="icon-button" title="More options" aria-haspopup="menu" aria-expanded={convMenuOpen} onClick={() => setConvMenuOpen((open) => !open)}>
                  <MoreVertical size={18} />
                </button>
                {convMenuOpen && (
                  <>
                    <div className="menu-backdrop" onClick={() => setConvMenuOpen(false)} aria-hidden="true" />
                    <div className="menu" role="menu">
                      <button className="menu-item" role="menuitem" onClick={() => toggleMute(selected)}>
                        {selected.muted ? <><Bell size={15} /> Unmute notifications</> : <><BellOff size={15} /> Mute notifications</>}
                      </button>
                      <button className="menu-item" role="menuitem" onClick={() => toggleArchive(selected)}>
                        {selected.archived ? <><Inbox size={15} /> Unarchive</> : <><Archive size={15} /> Archive</>}
                      </button>
                      <button className="menu-item danger" role="menuitem" onClick={() => removeConversation(selected)}>
                        {selected.type === "DIRECT" ? <><Trash2 size={15} /> Delete chat</> : <><LogOut size={15} /> Leave conversation</>}
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </header>

        {selected && messages.some((m) => m.pinnedAt) && (
          <button className="pinned-bar" onClick={() => setPinnedOpen(true)}>
            <Pin size={14} /> {messages.filter((m) => m.pinnedAt).length} pinned message{messages.filter((m) => m.pinnedAt).length > 1 ? "s" : ""}
          </button>
        )}

        <MessageList
          messages={messages}
          currentUserId={session.user.id}
          token={session.token}
          conversation={selected}
          onReply={setReplyTo}
          onForward={setForwardSource}
          onTogglePin={togglePin}
          hasMore={hasMore}
          onLoadOlder={loadOlder}
        />

        {showTyping && (
          <div className="typing-bubble">
            <span></span><span></span><span></span> {typing?.name} is typing
          </div>
        )}

        {selected && (
          <Composer
            token={session.token}
            self={session.user}
            conversation={selected}
            replyTo={replyTo}
            onClearReply={() => setReplyTo(null)}
            onTyping={emitTyping}
            onOptimistic={addOptimistic}
            onSettled={settleOptimistic}
          />
        )}
      </section>

      {profileOpen && (
        <ProfileDialog
          session={session}
          onClose={() => setProfileOpen(false)}
          onSave={(user) => setSession((current) => (current ? { ...current, user } : current))}
          onToken={(token) => setSession((current) => (current ? { ...current, token } : current))}
          onLogout={onLogout}
        />
      )}
      {forwardSource && (
        <ForwardDialog
          conversations={conversations}
          currentUserId={session.user.id}
          onClose={() => setForwardSource(null)}
          onPick={doForward}
        />
      )}
      {createOpen && <CreateConversationDialog friends={friends} onClose={() => setCreateOpen(false)} onCreate={createConversation} />}
      {galleryOpen && selected && <GalleryDialog token={session.token} conversation={selected} onClose={() => setGalleryOpen(false)} />}
      {callHistoryOpen && (
        <CallHistoryDialog token={session.token} currentUserId={session.user.id} conversationId={selected?.id} onClose={() => setCallHistoryOpen(false)} />
      )}
      {pinnedOpen && selected && (
        <PinnedDialog
          token={session.token}
          conversation={selected}
          onClose={() => setPinnedOpen(false)}
          onUnpin={togglePin}
        />
      )}
    </main>
    </CallProvider>
  );
}

function CallButtons({ selected, peer }: { selected?: Conversation; peer?: User }) {
  const { startCall, inCall } = useCall();
  if (!selected || selected.type !== "DIRECT" || !peer) return null;
  return (
    <>
      <button className="icon-button" disabled={inCall} title="Voice call" onClick={() => startCall(selected.id, "AUDIO", peer)}>
        <Phone size={18} />
      </button>
      <button className="icon-button" disabled={inCall} title="Video call" onClick={() => startCall(selected.id, "VIDEO", peer)}>
        <Video size={18} />
      </button>
    </>
  );
}

function CallHistoryDialog({
  token,
  currentUserId,
  conversationId,
  onClose
}: {
  token: string;
  currentUserId: string;
  conversationId?: string;
  onClose: () => void;
}) {
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [stats, setStats] = useState<CallStats | null>(null);
  const [scope, setScope] = useState<"chat" | "all">(conversationId ? "chat" : "all");

  useEffect(() => {
    void api.callHistory(token, scope === "chat" ? conversationId : undefined).then(({ calls }) => setCalls(calls));
    void api.callStats(token).then(setStats);
  }, [token, scope, conversationId]);

  return (
    <ModalShell onClose={onClose}>
      <section className="dialog call-history-dialog">
        <div className="dialog-head">
          <h2>Call history</h2>
          <button type="button" className="icon-button" onClick={onClose}><X size={18} /></button>
        </div>
        {stats && (
          <div className="call-stats">
            <div><strong>{stats.completed}</strong><span>completed</span></div>
            <div><strong>{stats.missed}</strong><span>missed</span></div>
            <div><strong>{stats.video}</strong><span>video</span></div>
            <div><strong>{formatCallDuration(stats.totalDurationSec)}</strong><span>total time</span></div>
          </div>
        )}
        {conversationId && (
          <div className="segmented">
            <button type="button" className={scope === "chat" ? "active" : ""} onClick={() => setScope("chat")}>This chat</button>
            <button type="button" className={scope === "all" ? "active" : ""} onClick={() => setScope("all")}>All calls</button>
          </div>
        )}
        <div className="call-history-list">
          {calls.length === 0 && <p className="empty">No calls yet.</p>}
          {calls.map((call) => {
            const outgoing = call.callerId === currentUserId;
            const missed = call.status === "MISSED" || call.status === "DECLINED";
            return (
              <div key={call.id} className={`call-history-item ${missed ? "missed" : ""}`}>
                <span className={`call-icon ${outgoing ? "out" : "in"}`}>
                  {call.type === "VIDEO" ? <Video size={16} /> : <Phone size={16} />}
                </span>
                <div className="call-history-meta">
                  <strong>{call.caller.displayName}</strong>
                  <small>
                    {outgoing ? "Outgoing" : "Incoming"} · {callStatusLabel(call.status)}
                    {call.status === "ENDED" ? ` · ${formatCallDuration(call.durationSec)}` : ""}
                  </small>
                </div>
                <time>{new Date(call.startedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>
                {call.recordingUrl && (
                  <a className="icon-button" href={api.mediaUrl(call.recordingUrl)} target="_blank" rel="noreferrer" title="Recording">
                    <Download size={16} />
                  </a>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </ModalShell>
  );
}

function callStatusLabel(status: CallRecord["status"]) {
  switch (status) {
    case "ENDED":
      return "Answered";
    case "MISSED":
      return "Missed";
    case "DECLINED":
      return "Declined";
    case "ONGOING":
      return "Ongoing";
    default:
      return "Ringing";
  }
}

function formatCallDuration(totalSeconds: number) {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function EncryptionProvider({ token, user, children }: { token: string; user: User; children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [needsUnlock, setNeedsUnlock] = useState(false);
  const privateKeyRef = useRef<CryptoKey | null>(null);
  const keyCacheRef = useRef<Map<string, CryptoKey>>(new Map());

  useEffect(() => {
    let active = true;
    keyCacheRef.current.clear();
    privateKeyRef.current = null;
    setReady(false);
    setNeedsUnlock(false);
    loadLocalPrivateKey(user.id)
      .then((key) => {
        if (!active) return;
        if (key) {
          privateKeyRef.current = key;
          setReady(true);
        } else {
          setNeedsUnlock(true);
        }
      })
      .catch(() => active && setNeedsUnlock(true));
    return () => {
      active = false;
    };
  }, [user.id]);

  const getConversationKey = useCallback(
    async (conversation: Conversation) => {
      const cached = keyCacheRef.current.get(conversation.id);
      if (cached) return cached;
      const peer = peerWithKey(conversation, user.id);
      if (!peer?.publicKey || !privateKeyRef.current) return null;
      const key = await deriveConversationKey(privateKeyRef.current, peer.publicKey);
      keyCacheRef.current.set(conversation.id, key);
      return key;
    },
    [user.id]
  );

  const canEncrypt = useCallback(
    (conversation?: Conversation | null) => Boolean(ready && conversation && peerWithKey(conversation, user.id)),
    [ready, user.id]
  );

  const encryptForConversation = useCallback(
    async (conversation: Conversation, text: string) => {
      const key = ready ? await getConversationKey(conversation) : null;
      if (!key) return { body: text, encrypted: false };
      return { body: await encryptText(key, text), encrypted: true };
    },
    [ready, getConversationKey]
  );

  const decryptForConversation = useCallback(
    async (conversation: Conversation, message: Message) => {
      if (!message.encrypted) return message.body;
      const key = await getConversationKey(conversation);
      if (!key) return null;
      try {
        return await decryptText(key, message.body);
      } catch {
        return null;
      }
    },
    [getConversationKey]
  );

  async function unlock(password: string) {
    const key = await setupKeys(token, user.id, password);
    privateKeyRef.current = key;
    keyCacheRef.current.clear();
    setReady(true);
    setNeedsUnlock(false);
  }

  const value = useMemo<EncryptionController>(
    () => ({ ready, canEncrypt, encryptForConversation, decryptForConversation }),
    [ready, canEncrypt, encryptForConversation, decryptForConversation]
  );

  return (
    <EncryptionContext.Provider value={value}>
      {children}
      {needsUnlock && <UnlockDialog onUnlock={unlock} onSkip={() => setNeedsUnlock(false)} />}
    </EncryptionContext.Provider>
  );
}

function UnlockDialog({ onUnlock, onSkip }: { onUnlock: (password: string) => Promise<void>; onSkip: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      await onUnlock(password);
    } catch (err) {
      setError(err instanceof WrongPasswordError ? "Incorrect password" : err instanceof Error ? err.message : "Unable to unlock");
    } finally {
      setLoading(false);
    }
  }

  return (
    <ModalShell onClose={onSkip}>
      <form className="dialog" onSubmit={submit}>
        <div className="dialog-head">
          <h2><Lock size={18} /> Unlock encryption</h2>
        </div>
        <p className="muted">
          Enter your password to restore your private key on this device and read encrypted messages. Your password is used locally and never sent in plain text.
        </p>
        <label>
          Password
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" autoFocus />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary-button" disabled={loading || !password}>{loading ? "Unlocking..." : "Unlock"}</button>
        <button type="button" className="link-button" onClick={onSkip}>Skip for now</button>
      </form>
    </ModalShell>
  );
}

function DecryptedBody({ conversation, message }: { conversation: Conversation; message: Message }) {
  const { ready, decryptForConversation } = useEncryption();
  const [text, setText] = useState<string | null>(message.encrypted ? null : message.body);

  useEffect(() => {
    let active = true;
    if (!message.encrypted) {
      setText(message.body);
      return;
    }
    void decryptForConversation(conversation, message).then((value) => {
      if (active) setText(value);
    });
    return () => {
      active = false;
    };
  }, [message.id, message.body, message.encrypted, conversation, decryptForConversation, ready]);

  if (message.encrypted && text === null) {
    return (
      <p className="locked-message">
        <Lock size={13} /> Encrypted message
      </p>
    );
  }
  return text ? <p>{text}</p> : null;
}

function DecryptedPreview({ conversation, message }: { conversation?: Conversation; message: Message }) {
  const { ready, decryptForConversation } = useEncryption();
  const [text, setText] = useState<string>(() => (message.encrypted ? "🔒 …" : previewMessage(message)));
  useEffect(() => {
    let active = true;
    if (!message.encrypted || !conversation) {
      setText(previewMessage(message));
      return;
    }
    void decryptForConversation(conversation, message).then((t) => {
      if (active) setText(t ?? "🔒 Encrypted message");
    });
    return () => {
      active = false;
    };
  }, [message.id, message.encrypted, conversation, decryptForConversation, ready]);
  return <>{text}</>;
}

function EncryptionBadge({ conversation }: { conversation?: Conversation | null }) {
  const { canEncrypt } = useEncryption();
  if (!canEncrypt(conversation)) return null;
  return (
    <span className="encryption-badge" title="Messages in this chat are end-to-end encrypted">
      <Lock size={12} /> Encrypted
    </span>
  );
}

function MessageList({
  messages,
  currentUserId,
  token,
  conversation,
  onReply,
  onForward,
  onTogglePin,
  hasMore,
  onLoadOlder
}: {
  messages: Message[];
  currentUserId: string;
  token: string;
  conversation?: Conversation;
  onReply: (message: Message) => void;
  onForward: (message: Message) => void;
  onTogglePin: (message: Message) => void;
  hasMore: boolean;
  onLoadOlder: () => Promise<void> | void;
}) {
  const { encryptForConversation, decryptForConversation } = useEncryption();
  const conversationId = conversation?.id ?? "";
  const others = (conversation?.members ?? []).filter((member) => member.id !== currentUserId);
  const lastMineId = [...messages].reverse().find((message) => message.senderId === currentUserId && !message.deletedAt)?.id;
  const listRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const loadingOlderRef = useRef(false);
  const pendingAnchorRef = useRef<number | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [showJump, setShowJump] = useState(false);
  const [editingId, setEditingId] = useState("");
  const [draft, setDraft] = useState("");
  const [reactPicker, setReactPicker] = useState("");
  const [lightbox, setLightbox] = useState<string | null>(null);

  const isNearBottom = useCallback(() => {
    const node = listRef.current;
    if (!node) return true;
    return node.scrollHeight - node.scrollTop - node.clientHeight < 120;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    bottomRef.current?.scrollIntoView({ behavior, block: "end" });
    atBottomRef.current = true;
    setShowJump(false);
  }, []);

  const handleScroll = useCallback(() => {
    const node = listRef.current;
    // Scrolled near the top with more history available → page older messages,
    // remembering the distance from the bottom so the view doesn't jump.
    if (node && hasMore && !loadingOlderRef.current && node.scrollTop < 80) {
      loadingOlderRef.current = true;
      pendingAnchorRef.current = node.scrollHeight - node.scrollTop;
      setLoadingOlder(true);
      Promise.resolve(onLoadOlder()).finally(() => {
        loadingOlderRef.current = false;
        setLoadingOlder(false);
      });
    }
    const near = isNearBottom();
    atBottomRef.current = near;
    setShowJump(!near);
  }, [isNearBottom, hasMore, onLoadOlder]);

  // After older messages are prepended, restore the scroll position so the
  // messages the user was reading stay put (anchor = distance from bottom).
  useLayoutEffect(() => {
    if (pendingAnchorRef.current != null && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight - pendingAnchorRef.current;
      pendingAnchorRef.current = null;
    }
  }, [messages.length]);

  // Jump straight to the latest message when switching conversations.
  useEffect(() => {
    scrollToBottom("auto");
  }, [conversationId, scrollToBottom]);

  // When the keyboard opens/closes the viewport resizes — if the user was
  // reading the latest messages, keep them pinned to the bottom (native feel).
  useEffect(() => {
    const vv = window.visualViewport;
    const onResize = () => {
      if (atBottomRef.current) scrollToBottom("auto");
    };
    vv?.addEventListener("resize", onResize);
    window.addEventListener("resize", onResize);
    return () => {
      vv?.removeEventListener("resize", onResize);
      window.removeEventListener("resize", onResize);
    };
  }, [scrollToBottom]);

  // Only auto-follow new messages if the user is already reading the bottom,
  // so scrolling up to older messages is never interrupted.
  useEffect(() => {
    if (atBottomRef.current) {
      scrollToBottom();
      const handles = [120, 420].map((delay) => window.setTimeout(() => scrollToBottom("auto"), delay));
      return () => handles.forEach(window.clearTimeout);
    }
    setShowJump(true);
  }, [messages.length, scrollToBottom]);

  async function startEdit(message: Message) {
    const text = conversation ? await decryptForConversation(conversation, message) : message.body;
    setEditingId(message.id);
    setDraft(text ?? message.body);
  }

  async function submitEdit(message: Message) {
    let body = draft.trim();
    if (!body) return;
    if (conversation && message.encrypted) {
      const result = await encryptForConversation(conversation, body);
      if (!result.encrypted) return; // refuse to downgrade an encrypted message to plaintext
      body = result.body;
    }
    await api.editMessage(token, conversationId, message.id, body);
    setEditingId("");
  }

  if (messages.length === 0) {
    return (
      <div className="message-list empty-chat">
        <MessageCircle size={42} />
        <h2>Start the conversation</h2>
        <p>Send text, images, video clips, or a voice note.</p>
      </div>
    );
  }

  return (
    <>
    <div className="message-list" ref={listRef} onScroll={handleScroll}>
      {loadingOlder && <div className="loading-older">Loading earlier messages…</div>}
      {messages.map((message) => {
        const mine = message.senderId === currentUserId;
        const reactionCounts = aggregateReactions(message);
        return (
          <article key={message.id} className={`message ${mine ? "mine" : ""} ${message.pending ? "pending" : ""}`}>
            {!mine && <Avatar user={message.sender} />}
            <div className="bubble">
              {message.pinnedAt && <div className="pin-marker"><Pin size={11} /> Pinned</div>}
              {message.replyTo && (
                <div className="reply-quote">
                  <strong>{message.replyTo.senderId === currentUserId ? "You" : message.replyTo.sender?.displayName}</strong>
                  <small><DecryptedPreview conversation={conversation} message={message.replyTo} /></small>
                </div>
              )}
              {message.deletedAt ? (
                <p className="muted">Message deleted</p>
              ) : (
                <>
                  <Media message={message} onReady={scrollToBottom} onZoom={setLightbox} />
                  {editingId === message.id ? (
                    <form
                      className="edit-row"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void submitEdit(message);
                      }}
                    >
                      <input value={draft} onChange={(event) => setDraft(event.target.value)} />
                      <button className="icon-button"><Check size={16} /></button>
                    </form>
                  ) : conversation ? (
                    <DecryptedBody conversation={conversation} message={message} />
                  ) : (
                    message.body && <p>{message.body}</p>
                  )}
                </>
              )}
              {reactionCounts.length > 0 && (
                <div className="reactions">
                  {reactionCounts.map(([emoji, count]) => (
                    <button key={emoji} onClick={() => void api.removeReaction(token, conversationId, message.id, emoji)}>
                      {emoji} {count}
                    </button>
                  ))}
                </div>
              )}
              <div className="message-meta">
                <time>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
                {message.editedAt && <span>edited</span>}
                {message.scheduledFor && !message.deliveredAt && <span>scheduled</span>}
                {mine && !message.deletedAt && message.deliveredAt && (
                  <Receipt status={receiptStatus(message, others)} showLabel={message.id === lastMineId} />
                )}
              </div>
              {!message.deletedAt && !message.pending && (
                <div className="message-actions">
                  {["👍", "❤️", "😂"].map((emoji) => (
                    <button key={emoji} onClick={() => void api.react(token, conversationId, message.id, emoji)} title={`React ${emoji}`}>
                      {emoji}
                    </button>
                  ))}
                  <button onClick={() => setReactPicker((id) => (id === message.id ? "" : message.id))} title="More reactions">
                    <Smile size={14} />
                  </button>
                  <button onClick={() => onReply(message)} title="Reply">
                    <Reply size={14} />
                  </button>
                  {!message.encrypted && (
                    <button onClick={() => onForward(message)} title="Forward">
                      <Forward size={14} />
                    </button>
                  )}
                  <button onClick={() => void onTogglePin(message)} title={message.pinnedAt ? "Unpin" : "Pin"} className={message.pinnedAt ? "active" : ""}>
                    <Pin size={14} />
                  </button>
                  {mine && message.type === "TEXT" && (
                    <button onClick={() => void startEdit(message)} title="Edit">
                      <Pencil size={14} />
                    </button>
                  )}
                  {mine && (
                    <button onClick={() => void api.deleteMessage(token, conversationId, message.id)} title="Delete">
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              )}
              {reactPicker === message.id && (
                <div className="emoji-picker">
                  {EMOJIS.map((emoji) => (
                    <button
                      key={emoji}
                      onClick={() => {
                        void api.react(token, conversationId, message.id, emoji);
                        setReactPicker("");
                      }}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </article>
        );
      })}
      <div ref={bottomRef} />
      </div>
      {showJump && (
        <button className="jump-latest" onClick={() => scrollToBottom()} title="Jump to latest">
          <ChevronDown size={20} />
        </button>
      )}
      {lightbox && <Lightbox src={lightbox} onClose={() => setLightbox(null)} />}
    </>
  );
}

type ReceiptState = "sent" | "delivered" | "seen";

function receiptStatus(message: Message, others: User[]): ReceiptState {
  if (others.length === 0) return "sent";
  const created = new Date(message.createdAt).getTime();
  const seen = others.every((member) => member.lastReadAt && new Date(member.lastReadAt).getTime() >= created);
  if (seen) return "seen";
  const delivered = others.every((member) => member.lastDeliveredAt && new Date(member.lastDeliveredAt).getTime() >= created);
  if (delivered) return "delivered";
  return "sent";
}

function Receipt({ status, showLabel }: { status: ReceiptState; showLabel: boolean }) {
  const label = status === "seen" ? "Seen" : status === "delivered" ? "Delivered" : "Sent";
  return (
    <span className={`receipt ${status}`} title={label}>
      {status === "sent" ? <Check size={13} /> : <CheckCheck size={13} />}
      {showLabel && <span className="receipt-label">{label}</span>}
    </span>
  );
}

function Media({ message, onReady, onZoom }: { message: Message; onReady?: () => void; onZoom?: (src: string) => void }) {
  const [failed, setFailed] = useState(false);
  if (!message.mediaUrl) return null;
  const source = api.mediaUrl(message.mediaUrl);
  // Older media stored on the (ephemeral) local disk may have been wiped by a
  // redeploy — show a clear placeholder instead of a broken-image icon.
  if (failed) {
    return (
      <div className="media media-unavailable">
        <Images size={20} /> Media unavailable
      </div>
    );
  }
  if (message.type === "IMAGE")
    return (
      <img
        className="media image"
        src={source}
        alt=""
        loading="lazy"
        onLoad={onReady}
        onError={() => setFailed(true)}
        onClick={() => onZoom?.(source)}
      />
    );
  if (message.type === "VIDEO") return <video className="media video" src={source} controls onLoadedMetadata={onReady} onError={() => setFailed(true)} />;
  if (message.type === "VOICE") return <audio className="media audio" src={source} controls onLoadedMetadata={onReady} onError={() => setFailed(true)} />;
  return null;
}

function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="lightbox" onClick={onClose} role="dialog" aria-modal="true">
      <button className="lightbox-close" onClick={onClose} aria-label="Close"><X size={24} /></button>
      <img src={src} alt="" onClick={(event) => event.stopPropagation()} />
    </div>
  );
}

function Composer({
  token,
  self,
  conversation,
  replyTo,
  onClearReply,
  onTyping,
  onOptimistic,
  onSettled
}: {
  token: string;
  self: User;
  conversation: Conversation;
  replyTo: Message | null;
  onClearReply: () => void;
  onTyping: (conversationId: string) => void;
  onOptimistic: (message: Message) => void;
  onSettled: (tempId: string, real: Message | null) => void;
}) {
  const { encryptForConversation } = useEncryption();
  const conversationId = conversation.id;
  const [body, setBody] = useState("");
  const [scheduledFor, setScheduledFor] = useState("");
  const [recording, setRecording] = useState(false);
  const [recordingError, setRecordingError] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);

  useEffect(() => {
    return () => {
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  function makeTemp(partial: Partial<Message>): Message {
    const now = new Date().toISOString();
    return {
      id: `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      conversationId,
      senderId: self.id,
      sender: self,
      type: "TEXT",
      body: "",
      mediaUrl: null,
      originalMediaUrl: null,
      storageProvider: "local",
      mediaMime: null,
      mediaSize: null,
      editedAt: null,
      deletedAt: null,
      scheduledFor: null,
      deliveredAt: now,
      createdAt: now,
      reactions: [],
      pending: true,
      ...partial
    };
  }

  async function sendText(event: React.FormEvent) {
    event.preventDefault();
    const text = body.trim();
    if (!text) return;
    setBody("");
    setEmojiOpen(false);
    const scheduledIso = scheduledFor ? new Date(scheduledFor).toISOString() : undefined;
    setScheduledFor("");
    const replyId = replyTo?.id;
    const replySnapshot = replyTo;
    onClearReply();

    // Show it instantly (unless it's scheduled for later).
    const temp = makeTemp({ body: text, replyToId: replyId ?? null, replyTo: replySnapshot ?? null });
    if (!scheduledIso) onOptimistic(temp);
    try {
      const { body: payload, encrypted } = await encryptForConversation(conversation, text);
      const { message } = await api.sendMessage(token, conversationId, payload, scheduledIso, encrypted, replyId);
      if (!scheduledIso) onSettled(temp.id, message.deliveredAt ? message : null);
    } catch {
      if (!scheduledIso) onSettled(temp.id, null);
      setRecordingError("Failed to send message");
    }
  }

  async function sendFile(file: File | undefined) {
    if (!file) return;
    const type = file.type.startsWith("image/") ? "IMAGE" : file.type.startsWith("video/") ? "VIDEO" : "VOICE";
    const temp = makeTemp({ type, mediaUrl: URL.createObjectURL(file), mediaMime: file.type, mediaSize: file.size });
    onOptimistic(temp);
    try {
      const { message } = await api.sendMedia(token, conversationId, file, "", undefined);
      onSettled(temp.id, message);
    } catch {
      onSettled(temp.id, null);
    }
    if (fileRef.current) fileRef.current.value = "";
  }

  async function toggleRecording() {
    if (recording) {
      recorderRef.current?.stop();
      return;
    }

    try {
      setRecordingError("");
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
        setRecordingError("Voice recording is not supported in this browser.");
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      streamRef.current = stream;
      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };

      recorder.onstop = () => {
        const mimeType = recorder.mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type: mimeType });
        const extension = mimeType.includes("mp4") ? "m4a" : "webm";
        const voiceNote = new File([blob], `voice-note-${Date.now()}.${extension}`, { type: mimeType });
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        recorderRef.current = null;
        chunksRef.current = [];
        setRecording(false);
        if (blob.size > 0) void sendFile(voiceNote);
      };

      recorder.start();
      setRecording(true);
    } catch {
      setRecording(false);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      setRecordingError("Microphone permission was blocked.");
    }
  }

  return (
    <div className="composer-wrap">
      {replyTo && (
        <div className="reply-banner">
          <div>
            <strong>Replying to {replyTo.senderId === self.id ? "yourself" : replyTo.sender?.displayName}</strong>
            <small><DecryptedPreview conversation={conversation} message={replyTo} /></small>
          </div>
          <button className="icon-button" onClick={onClearReply} title="Cancel reply"><X size={16} /></button>
        </div>
      )}
      {emojiOpen && (
        <div className="emoji-picker composer-emoji">
          {EMOJIS.map((emoji) => (
            <button key={emoji} type="button" onClick={() => setBody((b) => b + emoji)}>
              {emoji}
            </button>
          ))}
        </div>
      )}
      <form className="composer" onSubmit={sendText}>
        <input ref={fileRef} type="file" accept="image/*,video/*,audio/*" hidden onChange={(event) => void sendFile(event.target.files?.[0])} />
        <button type="button" className="icon-button" onClick={() => fileRef.current?.click()} title="Attach media">
          <Paperclip size={19} />
        </button>
        <button type="button" className="icon-button" onClick={() => setCameraOpen(true)} title="Take a photo">
          <Camera size={19} />
        </button>
        <button type="button" className={`icon-button ${recording ? "recording" : ""}`} onClick={() => void toggleRecording()} title={recording ? "Stop recording" : "Record voice note"}>
          <Mic size={19} />
        </button>
        <button type="button" className={`icon-button ${emojiOpen ? "active" : ""}`} onClick={() => setEmojiOpen((o) => !o)} title="Emoji">
          <Smile size={19} />
        </button>
        {recording && <span className="recording-pill">Recording</span>}
        {recordingError && <span className="composer-error">{recordingError}</span>}
        <label className="schedule-control" title="Schedule delivery">
          <CalendarClock size={18} />
          <input type="datetime-local" value={scheduledFor} onChange={(event) => setScheduledFor(event.target.value)} />
        </label>
        <input
          value={body}
          onChange={(event) => {
            setBody(event.target.value);
            onTyping(conversationId);
          }}
          placeholder="Message privately"
        />
        <button className="send-button" disabled={!body.trim()}>
          <Send size={18} />
        </button>
      </form>
      {cameraOpen && <CameraDialog onClose={() => setCameraOpen(false)} onCapture={(file) => { setCameraOpen(false); void sendFile(file); }} />}
    </div>
  );
}

function CameraDialog({ onClose, onCapture }: { onClose: () => void; onCapture: (file: File) => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const [error, setError] = useState("");
  const [facing, setFacing] = useState<"user" | "environment">("user");
  const [mode, setMode] = useState<"PHOTO" | "VIDEO">("PHOTO");
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    let active = true;
    // Stop any previous stream before switching cameras / modes.
    streamRef.current?.getTracks().forEach((t) => t.stop());
    navigator.mediaDevices
      // Video mode also captures audio; `exact` forces front/back on phones.
      ?.getUserMedia({ video: { facingMode: { ideal: facing } }, audio: mode === "VIDEO" })
      .then((stream) => {
        if (!active) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
      })
      .catch(() => setError("Camera permission was blocked."));
    return () => {
      active = false;
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [facing, mode]);

  function capturePhoto() {
    const video = videoRef.current;
    if (!video) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      // Mirror the front camera so the saved photo matches the mirrored preview.
      if (facing === "user") {
        ctx.translate(canvas.width, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(video, 0, 0);
    }
    canvas.toBlob((blob) => {
      if (blob) onCapture(new File([blob], `photo-${Date.now()}.jpg`, { type: "image/jpeg" }));
    }, "image/jpeg", 0.92);
  }

  function toggleVideo() {
    if (recording) {
      recorderRef.current?.stop();
      return;
    }
    const stream = streamRef.current;
    if (!stream) return;
    try {
      const mimeType = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"].find(
        (type) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type)
      );
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const type = recorder.mimeType || "video/webm";
        const blob = new Blob(chunksRef.current, { type });
        const ext = type.includes("mp4") ? "mp4" : "webm";
        setRecording(false);
        if (blob.size > 0) onCapture(new File([blob], `video-${Date.now()}.${ext}`, { type }));
      };
      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
    } catch {
      setError("Video recording is not supported on this device.");
    }
  }

  return (
    <ModalShell onClose={onClose}>
      <section className="dialog camera-dialog">
        <div className="dialog-head">
          <h2><Camera size={18} /> Camera</h2>
          <button type="button" className="icon-button" onClick={onClose}><X size={18} /></button>
        </div>
        {error ? (
          <p className="error">{error}</p>
        ) : (
          <>
            {!recording && (
              <div className="segmented">
                <button type="button" className={mode === "PHOTO" ? "active" : ""} onClick={() => setMode("PHOTO")}>Photo</button>
                <button type="button" className={mode === "VIDEO" ? "active" : ""} onClick={() => setMode("VIDEO")}>Video</button>
              </div>
            )}
            <div className="camera-frame">
              <video ref={videoRef} className={`camera-preview ${facing === "user" ? "mirror" : ""}`} autoPlay playsInline muted />
              {recording && <span className="call-recording-dot">● REC</span>}
              {!recording && (
                <button
                  type="button"
                  className="camera-flip"
                  onClick={() => setFacing((f) => (f === "user" ? "environment" : "user"))}
                  title="Switch camera"
                  aria-label="Switch camera"
                >
                  <SwitchCamera size={20} />
                </button>
              )}
            </div>
            {mode === "PHOTO" ? (
              <button className="primary-button" onClick={capturePhoto}>Capture &amp; send</button>
            ) : (
              <button className={`primary-button ${recording ? "danger-button" : ""}`} onClick={toggleVideo}>
                {recording ? "Stop &amp; send" : "Start recording"}
              </button>
            )}
          </>
        )}
      </section>
    </ModalShell>
  );
}

function PinnedDialog({
  token,
  conversation,
  onClose,
  onUnpin
}: {
  token: string;
  conversation: Conversation;
  onClose: () => void;
  onUnpin: (message: Message) => void;
}) {
  const [pins, setPins] = useState<Message[]>([]);
  useEffect(() => {
    void api.pins(token, conversation.id).then(({ pins }) => setPins(pins));
  }, [token, conversation.id]);

  return (
    <ModalShell onClose={onClose}>
      <section className="dialog">
        <div className="dialog-head">
          <h2><Pin size={18} /> Pinned messages</h2>
          <button type="button" className="icon-button" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="call-history-list">
          {pins.length === 0 && <p className="empty">No pinned messages yet.</p>}
          {pins.map((pin) => (
            <div key={pin.id} className="call-history-item">
              <div className="call-history-meta">
                <strong>{pin.sender?.displayName}</strong>
                <small><DecryptedPreview conversation={conversation} message={pin} /></small>
              </div>
              <button className="icon-button" title="Unpin" onClick={() => { onUnpin(pin); setPins((c) => c.filter((p) => p.id !== pin.id)); }}>
                <Pin size={15} />
              </button>
            </div>
          ))}
        </div>
      </section>
    </ModalShell>
  );
}

function PresenceAvatar({ user }: { user: User }) {
  return (
    <div className="avatar-wrap">
      <Avatar user={user} />
      {user.online && <span className="presence-dot" title="Online" />}
    </div>
  );
}

function formatLastSeen(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}

function ProfileDialog({
  session,
  onClose,
  onSave,
  onToken,
  onLogout
}: {
  session: Session;
  onClose: () => void;
  onSave: (user: User) => void;
  onToken: (token: string) => void;
  onLogout: () => void;
}) {
  const [tab, setTab] = useState<"profile" | "security">("profile");
  const [displayName, setDisplayName] = useState(session.user.displayName);
  const [username, setUsername] = useState(session.user.username);
  const [bio, setBio] = useState(session.user.bio);
  const [avatarUrl, setAvatarUrl] = useState(session.user.avatarUrl ?? "");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Change-password fields.
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [pwError, setPwError] = useState("");
  const [pwStatus, setPwStatus] = useState("");
  const [changing, setChanging] = useState(false);

  // Delete-account fields.
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setStatus("");
    setSaving(true);
    try {
      const { user } = await api.updateProfile(session.token, {
        displayName,
        bio,
        avatarUrl,
        username: username !== session.user.username ? username : undefined
      });
      onSave(user);
      setStatus("Profile saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save profile");
    } finally {
      setSaving(false);
    }
  }

  async function uploadAvatar(file: File | undefined) {
    if (!file) return;
    setError("");
    try {
      const { user } = await api.uploadAvatar(session.token, file);
      setAvatarUrl(user.avatarUrl ?? "");
      onSave(user);
      setStatus("Photo updated");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to upload photo");
    }
    if (fileRef.current) fileRef.current.value = "";
  }

  async function changePassword(event: React.FormEvent) {
    event.preventDefault();
    setPwError("");
    setPwStatus("");
    setChanging(true);
    try {
      // Re-wrap the E2EE private key under the new password (if this device has
      // one) so encrypted history stays readable after the change.
      const keyBackup = (await rewrapLocalPrivateKey(session.user.id, newPassword)) ?? undefined;
      const { token } = await api.changePassword(session.token, { currentPassword, newPassword, keyBackup });
      onToken(token);
      setCurrentPassword("");
      setNewPassword("");
      setPwStatus("Password changed");
    } catch (err) {
      setPwError(err instanceof Error ? err.message : "Unable to change password");
    } finally {
      setChanging(false);
    }
  }

  async function deleteAccount(event: React.FormEvent) {
    event.preventDefault();
    setDeleteError("");
    if (!window.confirm("Permanently delete your account? This cannot be undone.")) return;
    setDeleting(true);
    try {
      await api.deleteAccount(session.token, deletePassword);
      onLogout();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Unable to delete account");
      setDeleting(false);
    }
  }

  return (
    <ModalShell onClose={onClose}>
      <section className="dialog">
        <div className="dialog-head">
          <h2>Account settings</h2>
          <button type="button" className="icon-button" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="segmented">
          <button type="button" className={tab === "profile" ? "active" : ""} onClick={() => setTab("profile")}>Profile</button>
          <button type="button" className={tab === "security" ? "active" : ""} onClick={() => setTab("security")}>Security</button>
        </div>

        {tab === "profile" ? (
          <form className="dialog-body" onSubmit={save}>
            <div className="avatar-edit">
              <Avatar user={{ ...session.user, avatarUrl: avatarUrl || null }} />
              <input ref={fileRef} type="file" accept="image/*" hidden onChange={(event) => void uploadAvatar(event.target.files?.[0])} />
              <button type="button" className="ghost-button" onClick={() => fileRef.current?.click()}>
                <Upload size={15} /> Upload photo
              </button>
            </div>
            <label>
              Display name
              <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} minLength={2} maxLength={60} />
            </label>
            <label>
              Username
              <input value={username} onChange={(event) => setUsername(event.target.value)} minLength={3} maxLength={24} pattern="[a-zA-Z0-9_]+" />
            </label>
            <label>
              Bio
              <textarea value={bio} onChange={(event) => setBio(event.target.value)} maxLength={180} />
            </label>
            <label>
              Avatar URL
              <input value={avatarUrl} onChange={(event) => setAvatarUrl(event.target.value)} placeholder="https://…" />
            </label>
            {error && <p className="error">{error}</p>}
            {status && <p className="status">{status}</p>}
            <button className="primary-button" disabled={saving}>{saving ? "Saving…" : "Save profile"}</button>
          </form>
        ) : (
          <form className="dialog-body" onSubmit={changePassword}>
            <h3><KeyRound size={16} /> Change password</h3>
            <label>
              Current password
              <input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" />
            </label>
            <label>
              New password
              <input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" minLength={10} />
            </label>
            {pwError && <p className="error">{pwError}</p>}
            {pwStatus && <p className="status">{pwStatus}</p>}
            <button className="primary-button" disabled={changing || !currentPassword || newPassword.length < 10}>
              {changing ? "Updating…" : "Update password"}
            </button>

            <div className="danger-zone">
              <h3><Trash2 size={16} /> Delete account</h3>
              <p className="muted">This permanently removes your account, messages, and connections. This cannot be undone.</p>
              <label>
                Confirm password
                <input type="password" value={deletePassword} onChange={(event) => setDeletePassword(event.target.value)} autoComplete="current-password" />
              </label>
              {deleteError && <p className="error">{deleteError}</p>}
              <button type="button" className="danger-button" disabled={deleting || !deletePassword} onClick={deleteAccount}>
                {deleting ? "Deleting…" : "Delete my account"}
              </button>
            </div>
          </form>
        )}
      </section>
    </ModalShell>
  );
}

function CreateConversationDialog({
  friends,
  onClose,
  onCreate
}: {
  friends: User[];
  onClose: () => void;
  onCreate: (input: { type: "GROUP" | "CHANNEL"; name: string; description: string; memberIds: string[] }) => Promise<void>;
}) {
  const [type, setType] = useState<"GROUP" | "CHANNEL">("GROUP");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    await onCreate({ type, name, description, memberIds });
    setLoading(false);
  }

  return (
    <ModalShell onClose={onClose}>
      <form className="dialog" onSubmit={submit}>
        <div className="dialog-head">
          <h2>Create space</h2>
          <button type="button" className="icon-button" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="segmented">
          <button type="button" className={type === "GROUP" ? "active" : ""} onClick={() => setType("GROUP")}>
            Group
          </button>
          <button type="button" className={type === "CHANNEL" ? "active" : ""} onClick={() => setType("CHANNEL")}>
            Channel
          </button>
        </div>
        <label>
          Name
          <input value={name} onChange={(event) => setName(event.target.value)} minLength={2} maxLength={80} required />
        </label>
        <label>
          Description
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={240} />
        </label>
        <div className="member-picker">
          {friends.map((friend) => (
            <label key={friend.id} className="check-row">
              <input
                type="checkbox"
                checked={memberIds.includes(friend.id)}
                onChange={(event) =>
                  setMemberIds((current) => event.target.checked ? [...current, friend.id] : current.filter((id) => id !== friend.id))
                }
              />
              <Avatar user={friend} />
              <span>{friend.displayName}</span>
            </label>
          ))}
        </div>
        <button className="primary-button" disabled={loading}>{loading ? "Creating..." : "Create"}</button>
      </form>
    </ModalShell>
  );
}

function GalleryDialog({ token, conversation, onClose }: { token: string; conversation: Conversation; onClose: () => void }) {
  const [media, setMedia] = useState<Message[]>([]);
  const [filter, setFilter] = useState<"ALL" | "IMAGE" | "VIDEO" | "VOICE">("ALL");

  useEffect(() => {
    void api.mediaGallery(token, conversation.id).then(({ media }) => setMedia(media));
  }, [conversation.id, token]);

  const filtered = filter === "ALL" ? media : media.filter((message) => message.type === filter);

  return (
    <ModalShell onClose={onClose}>
      <section className="dialog gallery-dialog">
        <div className="dialog-head">
          <h2>Media gallery</h2>
          <button type="button" className="icon-button" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="segmented four">
          {(["ALL", "IMAGE", "VIDEO", "VOICE"] as const).map((item) => (
            <button key={item} type="button" className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>
              {item.toLowerCase()}
            </button>
          ))}
        </div>
        <div className="gallery-grid">
          {filtered.map((message) => (
            <a key={message.id} className="gallery-item" href={api.mediaUrl(message.originalMediaUrl ?? message.mediaUrl)} target="_blank" rel="noreferrer">
              {message.type === "IMAGE" && <img src={api.mediaUrl(message.mediaUrl)} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = "none"; }} />}
              {message.type === "VIDEO" && <video src={api.mediaUrl(message.mediaUrl)} onError={(e) => { e.currentTarget.style.display = "none"; }} />}
              {message.type === "VOICE" && <Mic size={28} />}
              <span><Download size={14} /> {formatBytes(message.mediaSize)}</span>
            </a>
          ))}
          {filtered.length === 0 && <p className="empty">No media shared here yet.</p>}
        </div>
      </section>
    </ModalShell>
  );
}

function Avatar({ user }: { user: User }) {
  const initials = useMemo(
    () =>
      user.displayName
        .split(" ")
        .map((part) => part[0])
        .join("")
        .slice(0, 2)
        .toUpperCase(),
    [user.displayName]
  );
  // Resolve relative upload paths (e.g. /uploads/avatars/…) against the API
  // origin; full http/blob/data URLs pass through unchanged.
  const src = api.mediaUrl(user.avatarUrl);
  const [failed, setFailed] = useState(false);
  // Reset the failure flag when the source changes (e.g. a new photo upload).
  useEffect(() => setFailed(false), [src]);
  return src && !failed ? (
    <img className="avatar" src={src} alt="" onError={() => setFailed(true)} />
  ) : (
    <div className="avatar">{initials}</div>
  );
}

type MenuItem = { label: string; icon?: React.ReactNode; danger?: boolean; onClick: () => void };

function KebabMenu({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="menu-wrap">
      <button className="icon-button" aria-haspopup="menu" aria-expanded={open} title="More options" onClick={() => setOpen((o) => !o)}>
        <MoreVertical size={16} />
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="menu" role="menu">
            {items.map((item) => (
              <button
                key={item.label}
                className={`menu-item ${item.danger ? "danger" : ""}`}
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  item.onClick();
                }}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ForwardDialog({
  conversations,
  currentUserId,
  onClose,
  onPick
}: {
  conversations: Conversation[];
  currentUserId: string;
  onClose: () => void;
  onPick: (conversationId: string) => void;
}) {
  return (
    <ModalShell onClose={onClose}>
      <section className="dialog">
        <div className="dialog-head">
          <h2><Forward size={18} /> Forward to…</h2>
          <button type="button" className="icon-button" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="call-history-list">
          {conversations.length === 0 && <p className="empty">No conversations to forward to.</p>}
          {conversations.map((conversation) => (
            <button key={conversation.id} className="result-item" onClick={() => onPick(conversation.id)}>
              {conversationTitle(conversation, currentUserId)}
            </button>
          ))}
        </div>
      </section>
    </ModalShell>
  );
}

function UserRow({ user, action }: { user: User; action?: React.ReactNode }) {
  return (
    <div className="user-row">
      <PresenceAvatar user={user} />
      <span>
        <strong>{user.displayName}</strong>
        <small>{user.online ? "Active now" : user.lastSeenAt ? `Last seen ${formatLastSeen(user.lastSeenAt)}` : `@${user.username}`}</small>
      </span>
      {action}
    </div>
  );
}

function previewMessage(message: Message) {
  if (message.deletedAt) return "Message deleted";
  if (message.encrypted) return "🔒 Encrypted message";
  if (message.type === "IMAGE") return "Photo";
  if (message.type === "VIDEO") return "Video";
  if (message.type === "VOICE") return "Voice note";
  return message.body;
}

function conversationTitle(conversation: Conversation, currentUserId: string) {
  if (conversation.type !== "DIRECT") return conversation.name ?? "Untitled";
  return conversation.members.find((member) => member.id !== currentUserId)?.displayName ?? conversation.members[0]?.displayName ?? "Private chat";
}

function aggregateReactions(message: Message) {
  const counts = new Map<string, number>();
  for (const reaction of message.reactions ?? []) {
    counts.set(reaction.emoji, (counts.get(reaction.emoji) ?? 0) + 1);
  }
  return Array.from(counts.entries());
}

function formatBytes(bytes: number | null) {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
