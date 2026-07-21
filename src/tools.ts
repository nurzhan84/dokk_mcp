// Tool registry — maps each MCP tool to a method on a shared DokkAgent.
//
// Tools deliberately stay close to the underlying collab ops (one per kind)
// instead of layering "create a flowchart"-style helpers. The LLM composes;
// we just expose primitives. See the design doc in PR description for why.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DokkAgent, type BoardElementLike } from './core/dokk-agent.js';
import {
  addArrowInput,
  addDrawingInput,
  addImageInput,
  addShapeInput,
  addTextInput,
  addYouTubeInput,
  arrangeInput,
  connectInput,
  createBoardInput,
  elementIdInput,
  moveCursorInput,
  setSelectionInput,
  switchBoardInput,
  updateElementInput,
} from './schemas.js';

/** JSON-stringified result wrapped in MCP's `content` envelope. */
function ok(payload: unknown): { content: { type: 'text'; text: string }[] } {
  return {
    content: [
      { type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) },
    ],
  };
}

function fail(err: unknown): { isError: true; content: { type: 'text'; text: string }[] } {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: 'text', text: message }] };
}

// YouTube URL → { videoId, start } parsing. Mirrors the SPA's parser in
// src/utils/youtube.ts (the MCP server is a separate package, so the ~30
// lines are duplicated rather than reaching across package roots) — keep
// the two in sync when adding URL shapes.
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;

function parseYouTubeStart(raw: string | null): number | undefined {
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw) > 0 ? Number(raw) : undefined;
  const m = raw.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m || (!m[1] && !m[2] && !m[3])) return undefined;
  const s = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return s > 0 ? s : undefined;
}

function parseYouTubeInput(raw: string): { videoId: string; start?: number } | null {
  const text = raw.trim();
  if (YT_ID_RE.test(text)) return { videoId: text };
  if (!/^https?:\/\//i.test(text)) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\.|^m\./, '').toLowerCase();
  let videoId: string | null = null;
  if (host === 'youtu.be') {
    videoId = url.pathname.slice(1).split('/')[0] || null;
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com' || host === 'music.youtube.com') {
    if (url.pathname === '/watch') {
      videoId = url.searchParams.get('v');
    } else {
      const m = url.pathname.match(/^\/(?:shorts|live|embed|v)\/([^/?]+)/);
      videoId = m ? m[1] : null;
    }
  } else {
    return null;
  }
  if (!videoId || !YT_ID_RE.test(videoId)) return null;
  const start = parseYouTubeStart(url.searchParams.get('t') ?? url.searchParams.get('start'));
  return start !== undefined ? { videoId, start } : { videoId };
}

const EXT_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

/** Decode the HTML entities LLMs sometimes emit instead of raw characters
 *  (`&#10;` for newline, `&amp;` for `&`, etc.). Board text is rendered by
 *  React without `dangerouslySetInnerHTML`, so entities would otherwise
 *  display literally. Applied to known text fields before forwarding to
 *  the collab server. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  tab: '\t',
  newline: '\n',
};
function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (raw, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const cp = parseInt(body.slice(2), 16);
      if (Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff) return String.fromCodePoint(cp);
      return raw;
    }
    if (body.startsWith('#')) {
      const cp = parseInt(body.slice(1), 10);
      if (Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff) return String.fromCodePoint(cp);
      return raw;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? raw;
  });
}

/** Decode HTML entities in known text-bearing fields of an element patch.
 *  Non-string values pass through unchanged. */
const TEXT_FIELDS = new Set(['text', 'infoText']);
function decodeTextFields<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = { ...obj };
  for (const key of TEXT_FIELDS) {
    const v = out[key];
    if (typeof v === 'string') out[key] = decodeHtmlEntities(v);
  }
  return out as T;
}

// ----- Legibility checks ---------------------------------------------------
// Two failure modes the host kept seeing on agent-created shapes:
//   1. Text clipped vertically because height was set without considering
//      wrapped line count for the given width + fontSize.
//   2. Text invisible on the fill because the agent picked similar-luminance
//      colors (e.g. dark gray text on a dark navy fill).
// These helpers compute heuristics and return human-readable warnings; the
// shape is still created so the agent can see + correct via update_element.

const SHAPE_HORIZONTAL_PADDING_PX = 12; // per side
const SHAPE_VERTICAL_PADDING_PX = 12;   // per side
const CHAR_WIDTH_FACTOR = 0.55;         // rough avg glyph width ÷ fontSize
const LINE_HEIGHT_FACTOR = 1.3;
const WCAG_NORMAL_MIN = 4.5;
const WCAG_LARGE_MIN = 3.0;
const LARGE_TEXT_PX = 24; // fontSize threshold for the "large text" WCAG rule

/** Estimate how many lines `text` wraps to inside a box of width `boxWidth`,
 *  using a fontSize-derived avg glyph width. Honors explicit `\n` line breaks. */
function estimateWrappedLines(text: string, boxWidth: number, fontSize: number): number {
  const innerWidth = Math.max(1, boxWidth - SHAPE_HORIZONTAL_PADDING_PX * 2);
  const charWidth = Math.max(1, fontSize * CHAR_WIDTH_FACTOR);
  const charsPerLine = Math.max(1, Math.floor(innerWidth / charWidth));
  let total = 0;
  for (const rawLine of text.split('\n')) {
    if (rawLine.length === 0) { total += 1; continue; }
    const words = rawLine.split(/\s+/).filter(Boolean);
    if (words.length === 0) { total += 1; continue; }
    let lineLen = 0;
    let lines = 1;
    for (const word of words) {
      const add = lineLen === 0 ? word.length : word.length + 1;
      if (lineLen + add <= charsPerLine) {
        lineLen += add;
      } else if (word.length > charsPerLine) {
        // Long word — character-wraps. Account for the overflow chunks.
        const chunks = Math.ceil(word.length / charsPerLine);
        lines += chunks;
        lineLen = word.length % charsPerLine || charsPerLine;
      } else {
        lines += 1;
        lineLen = word.length;
      }
    }
    total += lines;
  }
  return total;
}

/** Required vertical pixels to render `text` at `fontSize` inside `boxWidth`.
 *  Used to flag shapes whose height would clip the wrapped text. */
function estimateRequiredHeight(text: string, boxWidth: number, fontSize: number): number {
  const lines = estimateWrappedLines(text, boxWidth, fontSize);
  return Math.ceil(lines * fontSize * LINE_HEIGHT_FACTOR + SHAPE_VERTICAL_PADDING_PX * 2);
}

/** Parse #rgb / #rgba / #rrggbb / #rrggbbaa to [r,g,b,a] in 0..1. */
function parseHex(input: string): [number, number, number, number] | null {
  const m = /^#([0-9a-fA-F]{3,8})$/.exec(input);
  if (!m) return null;
  const hex = m[1];
  const expand = (h: string): number => parseInt(h.length === 1 ? h + h : h, 16) / 255;
  if (hex.length === 3) return [expand(hex[0]), expand(hex[1]), expand(hex[2]), 1];
  if (hex.length === 4) return [expand(hex[0]), expand(hex[1]), expand(hex[2]), expand(hex[3])];
  if (hex.length === 6) return [
    parseInt(hex.slice(0, 2), 16) / 255,
    parseInt(hex.slice(2, 4), 16) / 255,
    parseInt(hex.slice(4, 6), 16) / 255,
    1,
  ];
  if (hex.length === 8) return [
    parseInt(hex.slice(0, 2), 16) / 255,
    parseInt(hex.slice(2, 4), 16) / 255,
    parseInt(hex.slice(4, 6), 16) / 255,
    parseInt(hex.slice(6, 8), 16) / 255,
  ];
  return null;
}

function srgbToLinear(c: number): number {
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance for an sRGB triple in 0..1. */
function luminance(r: number, g: number, b: number): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/** WCAG contrast ratio between two hex colors. Returns null if either is
 *  unparseable (e.g. one is transparent / undefined). */
function contrastRatio(fgHex: string, bgHex: string): number | null {
  const fg = parseHex(fgHex);
  const bg = parseHex(bgHex);
  if (!fg || !bg) return null;
  // If the foreground is fully transparent there is effectively no text.
  if (fg[3] === 0) return null;
  const Lfg = luminance(fg[0], fg[1], fg[2]);
  const Lbg = luminance(bg[0], bg[1], bg[2]);
  const lighter = Math.max(Lfg, Lbg);
  const darker = Math.min(Lfg, Lbg);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Pick whichever of white / black contrasts better with `bgHex`. Used in
 *  warning hints so the agent has a concrete fix to copy. */
function suggestedTextColor(bgHex: string): '#ffffff' | '#0f172a' {
  const white = contrastRatio('#ffffff', bgHex) ?? 1;
  const dark = contrastRatio('#0f172a', bgHex) ?? 1;
  return white >= dark ? '#ffffff' : '#0f172a';
}

type ShapeLegibilityInput = {
  text?: string;
  infoText?: string;
  width: number;
  height: number;
  fontSize?: number;
  /** Shape fill (background). */
  color?: string;
  textColor?: string;
};

/** Whether a hex color is fully transparent (alpha = 0). Transparent fills
 *  have no visible background to contrast against, so we skip auto-fixing
 *  text color when the bg is transparent. */
function isFullyTransparent(hex: string | undefined): boolean {
  if (!hex) return false;
  const parsed = parseHex(hex);
  return parsed !== null && parsed[3] === 0;
}

/** Pick a textColor that contrasts ≥ 4.5:1 (or 3:1 for ≥ 24px text) against
 *  the shape's fill. Used both when the agent omitted `textColor` (the SPA
 *  would default to #000000, which is invisible on dark fills) and when the
 *  agent's chosen color sits too close in luminance to the fill. Warn-only
 *  didn't change agent behavior — we now overwrite and report what we did. */
function autoFixTextColor(opts: {
  color: string | undefined;
  textColor: string | undefined;
  fontSize: number;
}): { textColor: string | undefined; fixed: string | null } {
  const { color, textColor, fontSize } = opts;
  if (!color || isFullyTransparent(color)) {
    return { textColor, fixed: null };
  }
  const min = fontSize >= LARGE_TEXT_PX ? WCAG_LARGE_MIN : WCAG_NORMAL_MIN;
  if (textColor) {
    const ratio = contrastRatio(textColor, color);
    if (ratio === null) return { textColor, fixed: null };
    if (ratio >= min) return { textColor, fixed: null };
    const suggestion = suggestedTextColor(color);
    return {
      textColor: suggestion,
      fixed:
        `auto-fixed textColor ${textColor}→${suggestion}: contrast was ${ratio.toFixed(2)}:1 ` +
        `against color ${color} (WCAG wants ≥ ${min}:1 at fontSize ${fontSize}). ` +
        `Next time, pick a textColor that contrasts with the fill — light text on dark fills, dark text on light fills.`,
    };
  }
  // No explicit textColor → SPA defaults to #000000, which is invisible on
  // dark fills. Pre-populate a contrasting value so the agent doesn't even
  // get the chance to render unreadable text.
  const suggestion = suggestedTextColor(color);
  return {
    textColor: suggestion,
    fixed:
      `auto-set textColor=${suggestion} based on the fill color ${color}. ` +
      `When you set a non-transparent \`color\`, also set a \`textColor\` that contrasts with it ` +
      `(≥ ${min}:1) — otherwise the SPA defaults text to black, which is invisible on dark fills.`,
  };
}

/** Compute the minimum height that fits `text` at `fontSize` inside `width`.
 *  Returns `{ height, grew }` — `grew` is the report line to attach when the
 *  caller's height was smaller. (Warnings have proven not to be enough on
 *  their own; agents tend to ignore them, so we actually resize.) */
function autoFitHeight(opts: {
  text: string | undefined;
  width: number;
  height: number;
  fontSize: number;
}): { height: number; grew: string | null } {
  const text = (opts.text ?? '').trim();
  if (text.length === 0) return { height: opts.height, grew: null };
  const required = estimateRequiredHeight(text, opts.width, opts.fontSize);
  if (required <= opts.height) return { height: opts.height, grew: null };
  return {
    height: required,
    grew:
      `auto-grew height ${opts.height}→${required} so the on-canvas text fits at ` +
      `fontSize ${opts.fontSize} inside width ${opts.width}. ` +
      `Next time, size shapes up-front using \`height >= lines * fontSize * 1.3 + 24\`.`,
  };
}

/** Map of Content-Type values we accept from HTTP responses. Falls back to
 *  extension-based detection when the response is missing/generic. */
const MIME_OK: Record<string, string> = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/gif': 'image/gif',
  'image/webp': 'image/webp',
  'image/svg+xml': 'image/svg+xml',
};

/** Cap on bytes we'll pull over HTTP — the data URL ends up in a collab op,
 *  which crosses the WebSocket and lands in every peer's memory. 10 MB is
 *  generous for a screenshot; refuse anything larger. */
const HTTP_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const HTTP_IMAGE_TIMEOUT_MS = 15_000;

/** Threshold (in chars / bytes of the raw data URL string) above which we
 *  surface a warning telling the agent to switch to a file path or URL.
 *  At base64's 4:3 ratio this is ~192 KB of actual image bytes — fine for
 *  small icons and logos, but already in the range where MCP clients
 *  start to chug. */
const LARGE_DATA_URL_WARN_BYTES = 256 * 1024;

async function fetchImageAsDataUrl(url: string): Promise<string> {
  // Node ≥18 has fetch + AbortSignal.timeout globally; no deps needed.
  const res = await fetch(url, {
    signal: AbortSignal.timeout(HTTP_IMAGE_TIMEOUT_MS),
    // Some hosts 403 unfamiliar UAs; identify but don't masquerade.
    headers: { 'User-Agent': 'dokk-mcp/0.0.1 (+image-fetch)' },
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(`fetch ${url} failed: ${res.status} ${res.statusText}`);
  }
  // Decide MIME from response header first, then URL extension as fallback.
  const rawType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  let mime = MIME_OK[rawType];
  if (!mime) {
    const ext = extname(new URL(url).pathname).toLowerCase();
    mime = EXT_MIME[ext];
  }
  if (!mime) {
    throw new Error(
      `unsupported image content-type "${rawType || '(none)'}" from ${url} ` +
      `(allowed: png / jpeg / gif / webp / svg)`,
    );
  }
  // Pre-check declared length when the server is honest about it.
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > HTTP_IMAGE_MAX_BYTES) {
    throw new Error(`image is ${declared} bytes, exceeds ${HTTP_IMAGE_MAX_BYTES} cap`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > HTTP_IMAGE_MAX_BYTES) {
    throw new Error(`image is ${buf.byteLength} bytes, exceeds ${HTTP_IMAGE_MAX_BYTES} cap`);
  }
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/** Accept a data URL passthrough, an http(s) URL we fetch + base64-encode,
 *  or an absolute local file path we read + base64-encode. Saves the LLM
 *  from threading raw bytes through tool calls. */
async function resolveImageSrc(src: string): Promise<string> {
  if (src.startsWith('data:')) return src;
  if (src.startsWith('http://') || src.startsWith('https://')) {
    return fetchImageAsDataUrl(src);
  }
  const ext = extname(src).toLowerCase();
  const mime = EXT_MIME[ext];
  if (!mime) throw new Error(`unsupported image extension: ${ext || '(none)'}`);
  const buf = readFileSync(src);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/** Eagerly open a session from DOKK_* env vars before the MCP client sends
 *  its first tool call. Used by the stdio bootstrap when DOKK_AUTOCONNECT=1
 *  so the agent can call add_xxx / list_xxx / etc. without an explicit
 *  dokk_connect. Logs to stderr on failure but does NOT throw — the MCP
 *  process should stay up so the agent can still call dokk_connect manually. */
export async function autoConnectFromEnvIfRequested(agent: DokkAgent): Promise<void> {
  if (process.env.DOKK_AUTOCONNECT !== '1' && process.env.DOKK_AUTOCONNECT !== 'true') return;
  try {
    const opts = applyConnectDefaults({});
    const result = await agent.connect(opts);
    console.error(
      `[dokk-mcp] autoconnected as ${result.peerId} on board ${result.boardId} ` +
      `(${result.readOnly ? 'read-only' : 'writable'})`,
    );
  } catch (err) {
    console.error('[dokk-mcp] autoconnect failed:', err instanceof Error ? err.message : err);
  }
}

/** Merge call-time args with `DOKK_*` env vars so MCP clients (Codex,
 *  Claude Desktop, etc.) can pre-supply credentials once in their config
 *  instead of forcing the agent to repeat them on every connect. */
function applyConnectDefaults(
  args: Partial<Parameters<DokkAgent['connect']>[0]>,
): Parameters<DokkAgent['connect']>[0] {
  const collabUrl = args.collabUrl ?? process.env.DOKK_COLLAB_URL;
  const boardId = args.boardId ?? process.env.DOKK_BOARD_ID;
  const inviteToken = args.inviteToken ?? process.env.DOKK_INVITE_TOKEN;
  const missing: string[] = [];
  if (!collabUrl) missing.push('collabUrl (or DOKK_COLLAB_URL)');
  if (!boardId) missing.push('boardId (or DOKK_BOARD_ID)');
  if (!inviteToken) missing.push('inviteToken (or DOKK_INVITE_TOKEN)');
  if (missing.length > 0) {
    throw new Error(`dokk_connect missing required: ${missing.join(', ')}`);
  }
  return {
    collabUrl: collabUrl!,
    boardId: boardId!,
    inviteToken: inviteToken!,
    name: args.name ?? process.env.DOKK_AGENT_NAME,
    controlledBy: args.controlledBy ?? process.env.DOKK_CONTROLLED_BY,
  };
}

export function registerTools(server: McpServer, agent: DokkAgent): void {
  // -- connection --------------------------------------------------------

  server.registerTool(
    'dokk_connect',
    {
      title: 'Connect to a Dokk board',
      description:
        'Open a collaborative session on the given board using an invite token. ' +
        'Required before any add_*/update/remove/arrange tool. Returns the agent\'s ' +
        'peerId, the initial element snapshot, and the host\'s hierarchy (for picking ' +
        'a parent chapter when creating new boards).\n\n' +
        'Any omitted field falls back to the matching DOKK_* env var ' +
        '(DOKK_COLLAB_URL / DOKK_BOARD_ID / DOKK_INVITE_TOKEN / DOKK_AGENT_NAME / ' +
        'DOKK_CONTROLLED_BY) — handy when the MCP client supplies them once in its ' +
        'config instead of via every tool call. Set DOKK_AUTOCONNECT=1 in the MCP ' +
        'process\'s env and the server connects on startup; you don\'t need to call ' +
        'this tool at all unless you want to switch boards.',
      inputSchema: connectInput.shape,
    },
    async (args) => {
      try {
        const opts = applyConnectDefaults(args);
        const result = await agent.connect(opts);
        return ok({
          peerId: result.peerId,
          boardId: result.boardId,
          isOwner: result.isOwner,
          readOnly: result.readOnly,
          allowedBoardIds: result.allowedBoardIds,
          peers: result.peers,
          snapshot: result.snapshot,
          hierarchyItems: result.hierarchyItems,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'dokk_disconnect',
    {
      title: 'Disconnect from the current board',
      description: 'Close the collab session cleanly. Idempotent.',
      inputSchema: {},
    },
    async () => {
      try {
        await agent.disconnect();
        return ok({ disconnected: true });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'dokk_switch_board',
    {
      title: 'Switch to another board (same invite)',
      description:
        'Disconnect from the current board and re-open a session on `boardId`, reusing the ' +
        'same invite token. The new board must be in the invite\'s scope.',
      inputSchema: switchBoardInput.shape,
    },
    async ({ boardId }) => {
      try {
        const result = await agent.switchBoard(boardId);
        return ok({
          peerId: result.peerId,
          boardId: result.boardId,
          isOwner: result.isOwner,
          readOnly: result.readOnly,
          snapshot: result.snapshot,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // -- hierarchy ---------------------------------------------------------

  server.registerTool(
    'dokk_create_board',
    {
      title: 'Ask the host to create a new board',
      description:
        'The host (the human peer with GitHub credentials) creates a new board in the ' +
        'document hierarchy and replies with its id. By default the agent immediately ' +
        'switches its session to the new board so subsequent add_* tools target it.',
      inputSchema: createBoardInput.shape,
    },
    async ({ title, parentChapterId, switchTo }) => {
      try {
        const newBoardId = await agent.createBoard({ title, parentChapterId });
        if (switchTo) {
          const result = await agent.switchBoard(newBoardId);
          return ok({ boardId: newBoardId, switched: true, snapshot: result.snapshot });
        }
        return ok({ boardId: newBoardId, switched: false });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // -- observation -------------------------------------------------------

  server.registerTool(
    'dokk_list_elements',
    {
      title: 'List elements on the current board',
      description: 'Returns the agent\'s in-memory mirror of the board snapshot.',
      inputSchema: {},
    },
    async () => {
      try {
        return ok({ boardId: agent.getBoardId(), elements: agent.listElements() });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'dokk_get_element',
    {
      title: 'Get one element by id',
      description: 'Returns the element from the mirror, or null if it\'s not present.',
      inputSchema: elementIdInput.shape,
    },
    async ({ id }) => {
      try {
        return ok({ element: agent.getElement(id) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'dokk_list_peers',
    {
      title: 'List peers in the current room',
      description: 'Returns the live peer roster (host + guests) on this board.',
      inputSchema: {},
    },
    async () => ok({ peers: agent.listPeers() }),
  );

  // -- element ops -------------------------------------------------------

  server.registerTool(
    'dokk_add_shape',
    {
      title: 'Add a shape element',
      description:
        'Add a rectangle / circle / triangle / rhombus / message / text / info shape. ' +
        'Returns the new element id, plus any legibility warnings.\n\n' +
        'Shape types — pick by intent:\n' +
        '  • rectangle / circle / triangle / rhombus: generic nodes for diagrams, flowcharts, etc.\n' +
        '  • text: bare label, no fill outline (prefer `dokk_add_text`).\n' +
        '  • message: speech-bubble-style callout for quotes, annotations, or commentary.\n' +
        '  • info: dedicated node for technical detail — background processes, endpoint ' +
        'request/response payloads, data examples, edge cases. The on-canvas label goes in ' +
        '`text` (keep it short — a name like "POST /orders" or "Order ingestion job"); the ' +
        'full long-form content (request/response bodies, sample payloads, sequence narrative) ' +
        'goes in `infoText`, which opens in a side panel when the user double-clicks the node. ' +
        'Connect multiple `info` nodes with `dokk_add_arrow` to model flows: chain them in ' +
        'sequence for a step-by-step process, or fan out / fan in for parallel branches.\n\n' +
        'Info-shape geometry is FIXED: a 32×32 blue circle. Any width / height / color / ' +
        'textColor / fontSize you pass for an info shape is ignored — the MCP server overrides ' +
        'them to match how the SPA itself creates info nodes (which are also non-resizable in ' +
        'the UI). Put your detail in `infoText`, not in custom sizing.\n\n' +
        'Markdown in `text` and `infoText`:\n' +
        '  • Both fields render through a markdown pass that supports fenced code blocks. ' +
        'Wrap code, JSON, shell commands, SQL, or any other structured snippet in triple-backtick ' +
        'fences with a language hint, e.g. ```json\\n{ "id": 1 }\\n```. Do this every time you ' +
        'include such content in `infoText` — it preserves whitespace and is much more readable.\n' +
        '  • Inline backticks (`like_this`) are also supported for short identifiers.\n\n' +
        'Rules to follow when sizing & styling text:\n' +
        '  • Pass `text` and `infoText` as raw strings — use a literal newline, not `\\n` or `&#10;`, and `&` not `&amp;`.\n' +
        '  • Size the shape so the on-canvas `text` fits. Rule of thumb: `height >= lines * fontSize * 1.3 + 24` ' +
        'where `lines` is the wrapped line count for the given `width`. ' +
        '⚠️ If the height you pass is too small, THE MCP SERVER AUTO-GROWS IT to fit. The response ' +
        'returns the actual height used in `appliedHeight` — use that for laying out neighboring ' +
        'shapes (e.g. stacking the next shape below). Don\'t rely on the height you passed in. ' +
        '(`infoText` is NOT shown on the canvas, so it does not affect sizing.)\n' +
        '  • Pick a `textColor` that contrasts with `color`. Dark fills (navy, black, dark slate) want ' +
        'light text like `#ffffff`. Light fills (white, beige, pastel) want dark text like `#0f172a`. ' +
        'WCAG wants ≥ 4.5:1 (≥ 3:1 for text ≥ 24px). ' +
        '⚠️ If you set a non-transparent `color` without setting `textColor`, the SPA defaults text ' +
        'to BLACK — invisible on dark fills. To prevent that, THE MCP SERVER NOW AUTO-PICKS a ' +
        'contrasting `textColor` whenever the one you sent (or didn\'t send) would be unreadable. ' +
        'The response returns `appliedTextColor` so you know what actually shipped — use it for any ' +
        'follow-up `update_element` so you don\'t fight the auto-fix.',
      inputSchema: addShapeInput.shape,
    },
    async (args) => {
      try {
        const decoded = decodeTextFields(args);
        const id = randomUUID();
        // Info shapes are a fixed 32×32 blue circle in the SPA (resize handles
        // are hidden in the UI). The agent can still pass sizes/colors via
        // the schema, so we hard-override here to match the SPA's create
        // behavior — otherwise you get the oval-with-tiny-text artifact.
        const isInfo = decoded.shapeType === 'info';
        const overrideNotes: string[] = [];
        if (isInfo) {
          const overridden = [
            decoded.width !== 32 ? 'width' : null,
            decoded.height !== 32 ? 'height' : null,
            decoded.color && decoded.color !== '#2563eb' ? 'color' : null,
            decoded.textColor && decoded.textColor !== '#000000' ? 'textColor' : null,
            decoded.fontSize && decoded.fontSize !== 16 ? 'fontSize' : null,
          ].filter((v): v is string => v !== null);
          if (overridden.length > 0) {
            overrideNotes.push(
              `info shape geometry is fixed; ignored ${overridden.join(', ')} ` +
              `(forced to 32×32 blue circle). Put detail in infoText instead.`,
            );
          }
          decoded.width = 32;
          decoded.height = 32;
          decoded.color = '#2563eb';
          decoded.textColor = '#000000';
          decoded.fontSize = 16;
        }
        // Auto-grow height so the on-canvas `text` doesn't clip. Warnings
        // alone didn't move the needle — agents tended to ignore them — so
        // we now resize and report what we did. Skipped for info shapes
        // (geometry already locked above).
        const notes = [...overrideNotes];
        let appliedHeight = decoded.height;
        let appliedTextColor = decoded.textColor;
        if (!isInfo) {
          const fit = autoFitHeight({
            text: decoded.text,
            width: decoded.width,
            height: decoded.height,
            fontSize: decoded.fontSize ?? 14,
          });
          if (fit.grew) {
            decoded.height = fit.height;
            appliedHeight = fit.height;
            notes.push(fit.grew);
          }
          const contrast = autoFixTextColor({
            color: decoded.color,
            textColor: decoded.textColor,
            fontSize: decoded.fontSize ?? 14,
          });
          if (contrast.fixed) {
            decoded.textColor = contrast.textColor;
            appliedTextColor = contrast.textColor;
            notes.push(contrast.fixed);
          }
        }
        const element: BoardElementLike = { id, type: 'shape', ...decoded };
        await agent.addElement(element);
        return ok({
          id,
          appliedHeight,
          ...(appliedTextColor !== undefined ? { appliedTextColor } : {}),
          ...(notes.length ? { warnings: notes } : {}),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'dokk_add_text',
    {
      title: 'Add a text element',
      description:
        'Shorthand for a `shape` of type `text` with sensible defaults. Returns the new id, ' +
        'the actual height used in `appliedHeight`, plus any legibility warnings.\n\n' +
        'Rules:\n' +
        '  • Pass `text` as a raw string — use a literal newline, not `\\n` or `&#10;`, and `&` not `&amp;`.\n' +
        '  • Text renders through markdown — wrap code, JSON, or shell snippets in triple-backtick ' +
        'fences (```lang\\n…\\n```). Inline backticks work for short identifiers.\n' +
        '  • If you set a `color` background, also set a contrasting `textColor` (≥ 4.5:1 WCAG). ' +
        'If you don\'t, the MCP server auto-picks one based on the fill luminance and returns ' +
        'it as `appliedTextColor` — black text on dark fills would otherwise be invisible.\n' +
        '  • ⚠️ Height is auto-grown if the value you pass is too small for the wrapped text. ' +
        'Use `appliedHeight` from the response when laying out neighboring elements. ' +
        'Omit `width` to let the SPA auto-size a single line.',
      inputSchema: addTextInput.shape,
    },
    async ({ x, y, text, width, height, color, textColor, fontSize, textAlign, rotation, fontFamily }) => {
      try {
        const id = randomUUID();
        const decodedText = decodeHtmlEntities(text);
        const finalWidth = width ?? 200;
        const finalFontSize = fontSize ?? 16;
        const finalColor = color ?? '#00000000';
        const finalTextColor = textColor ?? '#0f172a';
        // Auto-grow height if it's too small for the wrapped text. When the
        // caller omits `width`, the SPA's textAutoWidth keeps the line on
        // one row, so we leave height alone.
        const notes: string[] = [];
        let finalHeight = height ?? 48;
        if (width !== undefined) {
          const fit = autoFitHeight({ text: decodedText, width: finalWidth, height: finalHeight, fontSize: finalFontSize });
          if (fit.grew) {
            finalHeight = fit.height;
            notes.push(fit.grew);
          }
        }
        // Skip contrast fix on the default transparent fill — no visible bg
        // to clash with — but apply it when the caller set an opaque color.
        let appliedTextColor = finalTextColor;
        const contrast = autoFixTextColor({
          color: color, // raw arg, NOT finalColor — the transparent default has no bg to fight
          textColor: textColor,
          fontSize: finalFontSize,
        });
        if (contrast.fixed && contrast.textColor) {
          appliedTextColor = contrast.textColor;
          notes.push(contrast.fixed);
        }
        const element: BoardElementLike = {
          id,
          type: 'shape',
          shapeType: 'text',
          x,
          y,
          width: finalWidth,
          height: finalHeight,
          text: decodedText,
          color: finalColor,
          textColor: appliedTextColor,
          fontSize: finalFontSize,
          textAlign: textAlign ?? 'left',
          textAutoWidth: width === undefined,
          rotation,
          fontFamily,
        };
        await agent.addElement(element);
        return ok({
          id,
          appliedHeight: finalHeight,
          appliedTextColor,
          ...(notes.length ? { warnings: notes } : {}),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'dokk_add_arrow',
    {
      title: 'Add an arrow element',
      description:
        'Connect two anchors. Each end can be either an existing nodeId (with optional port) ' +
        'or free-form coordinates (startX/startY / endX/endY). Returns the new id. ' +
        'Arrowheads are settable per end via `startHead` / `endHead` ' +
        "('none' | 'arrow' | 'circle'); defaults are startHead='none', endHead='arrow'. " +
        "Use endHead='none' for plain connector lines, 'circle' for schematic junction dots, " +
        'and heads on both ends for bidirectional relations.',
      inputSchema: addArrowInput.shape,
    },
    async (args) => {
      try {
        const id = randomUUID();
        const element: BoardElementLike = { id, type: 'arrow', ...args };
        await agent.addElement(element);
        return ok({ id });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'dokk_add_image',
    {
      title: 'Add an image element',
      description:
        '⚠️ STRONGLY PREFER a file path or `http(s)://` URL over an inline `data:` URL. ' +
        'Inline base64 has to travel through your MCP client\'s JSON-RPC pipe AND get rendered ' +
        'in its request UI; for screenshots / generated images (200 KB – 2 MB) this often ' +
        'stalls the client UI for a minute or more even though the Dokk side completes ' +
        'instantly. File paths and URLs are read entirely inside the MCP server process and ' +
        'cost nothing on the JSON-RPC side.\n\n' +
        '`src` accepts:\n' +
        '  • an absolute local file path — recommended for screenshots saved by Playwright / ' +
        'similar browser MCPs (e.g. /tmp/foo.png),\n' +
        '  • an `http(s)://` URL — the MCP server fetches the bytes, validates the content-type ' +
        '(png/jpg/gif/webp/svg), enforces a 10 MB cap and 15 s timeout, then base64-encodes,\n' +
        '  • a `data:` URL — passed through as-is. ONLY use this when you cannot save to disk ' +
        'and have no hosted URL — e.g. a tiny generated icon. The response will warn you when ' +
        'the data URL is large enough to be slow.',
      inputSchema: addImageInput.shape,
    },
    async ({ x, y, width, height, src, color, rotation }) => {
      try {
        const resolvedSrc = await resolveImageSrc(src);
        // If the caller handed us a large inline data URL, tell them so —
        // the cost was already paid (the bytes traveled through their MCP
        // client's JSON-RPC pipe to get here), but next time the agent
        // should reach for a file path / URL instead.
        const inlineNote: string[] = [];
        if (src.startsWith('data:') && src.length > LARGE_DATA_URL_WARN_BYTES) {
          const kb = Math.round(src.length / 1024);
          inlineNote.push(
            `inline data URL was ${kb} KB. That payload travels through your MCP client\'s ` +
            `JSON-RPC pipe AND renders in its request UI, which often stalls the UI for tens ` +
            `of seconds. Next time, save the image to a local file and pass the path, or pass ` +
            `an http(s)://… URL — the MCP server reads the bytes itself with no JSON-RPC cost.`,
          );
        }
        const id = randomUUID();
        const element: BoardElementLike = {
          id,
          type: 'image',
          x,
          y,
          width,
          height,
          src: resolvedSrc,
          color,
          rotation,
        };
        await agent.addElement(element);
        return ok(inlineNote.length ? { id, warnings: inlineNote } : { id });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'dokk_add_youtube',
    {
      title: 'Add an embedded YouTube video',
      description:
        'Embed a YouTube player on the board. `url` accepts any regular YouTube URL ' +
        '(watch?v=…, youtu.be/…, shorts/…, live/…, embed/…, optional t= timestamp) or a bare ' +
        '11-character video id. The element renders as the video thumbnail with a play button; ' +
        'clicking play swaps in the real player. Only the video id is stored — no binary ' +
        'payload. Default size is 560×315 (16:9); pass width/height to override. ' +
        'Position (x, y) is the top-left corner.',
      inputSchema: addYouTubeInput.shape,
    },
    async ({ url, x, y, width, height, rotation }) => {
      try {
        const parsed = parseYouTubeInput(url);
        if (!parsed) {
          return fail(new Error(
            `Not a recognizable YouTube URL or video id: "${url}". ` +
            'Expected youtube.com/watch?v=…, youtu.be/…, shorts/…, live/…, embed/…, or a bare 11-char id.',
          ));
        }
        const id = randomUUID();
        const element: BoardElementLike = {
          id,
          type: 'youtube',
          x,
          y,
          width: width ?? 560,
          height: height ?? 315,
          videoId: parsed.videoId,
          ...(parsed.start !== undefined ? { start: parsed.start } : {}),
          color: 'transparent',
          rotation,
        };
        await agent.addElement(element);
        return ok({ id, videoId: parsed.videoId });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'dokk_add_drawing',
    {
      title: 'Add a freeform drawing',
      description:
        'Add a path-based drawing (e.g. a sketched annotation). Points are expressed in ' +
        'baseWidth/baseHeight viewBox coordinates with per-point stroke width.',
      inputSchema: addDrawingInput.shape,
    },
    async (args) => {
      try {
        const id = randomUUID();
        const element: BoardElementLike = { id, type: 'drawing', ...args };
        await agent.addElement(element);
        return ok({ id });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'dokk_update_element',
    {
      title: 'Update fields on an existing element',
      description:
        'Shallow-merges `patch` into the element. Use to move, resize, recolor, retext, etc. ' +
        'Caller is responsible for sending only valid fields for the element\'s type. ' +
        'When updating `text`/`infoText`, pass raw strings (not HTML-encoded). ' +
        'Both fields render through markdown — wrap code/JSON snippets in triple-backtick fences ' +
        'with a language hint (```json … ```). ' +
        'For shapes, both height (to fit text) and textColor (to contrast with `color`) auto-fix ' +
        'in the same op as your patch. The response returns `appliedHeight` and `appliedTextColor` ' +
        'so you can see what actually shipped. ' +
        'For info shapes specifically, width / height / color / textColor / fontSize are locked ' +
        'and silently dropped from the patch. ' +
        "For arrows, `startHead` / `endHead` ('none' | 'arrow' | 'circle') change the arrowheads.",
      inputSchema: updateElementInput.shape,
    },
    async ({ id, patch }) => {
      try {
        const decoded = decodeTextFields(patch);
        // Info shapes have fixed geometry. Strip locked fields from the
        // patch so an agent that tries to "fix" the size after creation
        // can't stretch them into ovals via a back-door update.
        const existing = agent.getElement(id);
        let appliedPatch: Record<string, unknown> = decoded;
        const overrideNotes: string[] = [];
        if (existing && existing.type === 'shape' && existing.shapeType === 'info') {
          const LOCKED = ['width', 'height', 'color', 'textColor', 'fontSize'];
          const dropped = LOCKED.filter((k) => Object.prototype.hasOwnProperty.call(decoded, k));
          if (dropped.length > 0) {
            appliedPatch = Object.fromEntries(
              Object.entries(decoded).filter(([k]) => !LOCKED.includes(k)),
            );
            overrideNotes.push(
              `info shape geometry is fixed; dropped ${dropped.join(', ')} from patch.`,
            );
          }
        } else if (existing && existing.type === 'shape' && existing.shapeType !== 'info') {
          // Auto-grow + auto-contrast path: compute what the merged shape
          // would look like post-patch and bake any required height/
          // textColor fixes into the SAME op so the agent's edit and our
          // corrections land atomically (no follow-up flicker).
          const mergedPreview = { ...existing, ...appliedPatch };
          const fit = autoFitHeight({
            text: typeof mergedPreview.text === 'string' ? mergedPreview.text : '',
            width: typeof mergedPreview.width === 'number' ? mergedPreview.width : 0,
            height: typeof mergedPreview.height === 'number' ? mergedPreview.height : 0,
            fontSize: typeof mergedPreview.fontSize === 'number' ? mergedPreview.fontSize : 14,
          });
          if (fit.grew) {
            appliedPatch = { ...appliedPatch, height: fit.height };
            overrideNotes.push(fit.grew);
          }
          const contrast = autoFixTextColor({
            color: typeof mergedPreview.color === 'string' ? mergedPreview.color : undefined,
            textColor: typeof mergedPreview.textColor === 'string' ? mergedPreview.textColor : undefined,
            fontSize: typeof mergedPreview.fontSize === 'number' ? mergedPreview.fontSize : 14,
          });
          if (contrast.fixed && contrast.textColor) {
            appliedPatch = { ...appliedPatch, textColor: contrast.textColor };
            overrideNotes.push(contrast.fixed);
          }
        }
        await agent.updateElement(id, appliedPatch);
        const merged = agent.getElement(id);
        if (merged && merged.type === 'shape' && merged.shapeType !== 'info') {
          const appliedHeight = typeof merged.height === 'number' ? merged.height : undefined;
          const appliedTextColor = typeof merged.textColor === 'string' ? merged.textColor : undefined;
          return ok({
            updated: id,
            ...(appliedHeight !== undefined ? { appliedHeight } : {}),
            ...(appliedTextColor !== undefined ? { appliedTextColor } : {}),
            ...(overrideNotes.length ? { warnings: overrideNotes } : {}),
          });
        }
        return ok(overrideNotes.length ? { updated: id, warnings: overrideNotes } : { updated: id });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'dokk_remove_element',
    {
      title: 'Remove an element',
      description: 'Permanently remove the element from the board.',
      inputSchema: elementIdInput.shape,
    },
    async ({ id }) => {
      try {
        await agent.removeElement(id);
        return ok({ removed: id });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'dokk_arrange',
    {
      title: 'Reorder elements (z-order)',
      description: 'Move the selected ids up / down / to front / to back of the z-order.',
      inputSchema: arrangeInput.shape,
    },
    async ({ ids, direction }) => {
      try {
        await agent.arrange(ids, direction);
        return ok({ arranged: ids, direction });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // -- presence ----------------------------------------------------------

  server.registerTool(
    'dokk_move_cursor',
    {
      title: 'Move the agent\'s cursor',
      description:
        'Broadcasts the agent\'s cursor to the room (world coords). Pass `null` for both to ' +
        'park the cursor off-canvas. Useful for "I\'m about to do X" presence cues.',
      inputSchema: moveCursorInput.shape,
    },
    async ({ x, y }) => {
      try {
        agent.moveCursor(x, y);
        return ok({ ok: true });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'dokk_set_selection',
    {
      title: 'Set the agent\'s selection',
      description: 'Highlights the given element ids as the agent\'s selection for other peers.',
      inputSchema: setSelectionInput.shape,
    },
    async ({ ids }) => {
      try {
        agent.setSelection(ids);
        return ok({ ok: true });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // Silence unused-import warnings when schemas grow.
  void z;
}
