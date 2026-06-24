import { env } from "./env.js";

export type IceServer = { urls: string[]; username?: string; credential?: string };

/**
 * Builds the ICE server list advertised to clients. STUN is always present;
 * a TURN relay is added when configured so calls survive symmetric NATs and
 * networks that block peer-to-peer UDP (the China fallback strategy).
 */
export function iceServers(): IceServer[] {
  const servers: IceServer[] = [
    { urls: env.STUN_URLS.split(",").map((url) => url.trim()).filter(Boolean) }
  ];

  if (env.TURN_URLS) {
    servers.push({
      urls: env.TURN_URLS.split(",").map((url) => url.trim()).filter(Boolean),
      username: env.TURN_USERNAME,
      credential: env.TURN_CREDENTIAL
    });
  }

  return servers;
}
