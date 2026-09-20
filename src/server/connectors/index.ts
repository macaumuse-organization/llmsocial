import { instagramConnector } from './instagram.ts';
import type { Connector } from './types.ts';
import { wechatOaConnector } from './wechatOa.ts';
import { wecomKfConnector } from './wecomKf.ts';
import { xConnector } from './x.ts';
import { youtubeConnector } from './youtube.ts';

/** Connectors that talk to a real platform. The local ones (sandbox/manual/webhook) live in local.ts. */
export const REAL_CONNECTORS: Connector[] = [youtubeConnector, xConnector, instagramConnector, wechatOaConnector, wecomKfConnector];

export { instagramConnector, wechatOaConnector, wecomKfConnector, xConnector, youtubeConnector };
