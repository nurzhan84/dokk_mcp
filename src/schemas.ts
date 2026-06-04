// Zod schemas mirroring the SPA's `BoardElement` shape (src/store.ts).
//
// The collab server relays element bodies as opaque records and does not
// validate their shape, so this is the only layer that keeps an LLM from
// flooding the canvas with malformed elements. When the SPA type changes,
// mirror it here. (Lifting into a shared `packages/types` would also work
// — left as a follow-up if drift becomes painful.)

import { z } from 'zod';

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3,4}){1,2}$/;
const colorSchema = z.string().regex(HEX_COLOR, 'expected a hex color like #3b82f6');

const portSchema = z.enum(['top', 'right', 'bottom', 'left']);

const pointSchema = z.object({
  x: z.number(),
  y: z.number(),
});

const waypointSchema = pointSchema.extend({
  nodeId: z.string().optional(),
  attachment: pointSchema.optional(),
});

const drawingPointSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
});

// --- add tool inputs (omit id — minted by the tool layer) -----------------

export const addShapeInput = z.object({
  shapeType: z.enum(['rectangle', 'circle', 'triangle', 'rhombus', 'message', 'text', 'info']),
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
  color: colorSchema,
  text: z.string().optional(),
  infoText: z.string().optional(),
  textColor: colorSchema.optional(),
  fontSize: z.number().positive().optional(),
  textAlign: z.enum(['left', 'center', 'right']).optional(),
  textAutoWidth: z.boolean().optional(),
  rotation: z.number().optional(),
  fontFamily: z.string().optional(),
});

export const addTextInput = z.object({
  x: z.number(),
  y: z.number(),
  text: z.string(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  color: colorSchema.optional(),
  textColor: colorSchema.optional(),
  fontSize: z.number().positive().optional(),
  textAlign: z.enum(['left', 'center', 'right']).optional(),
  rotation: z.number().optional(),
  fontFamily: z.string().optional(),
});

export const addArrowInput = z.object({
  color: colorSchema.default('#475569'),
  lineWidth: z.number().positive().optional(),
  lineStyle: z.enum(['solid', 'dashed', 'dotted']).optional(),
  // Either anchor to an existing node (startId + optional startPort) OR
  // free-form via startX/startY. The SPA accepts both; we don't enforce
  // mutual exclusion so callers can mix (e.g. anchored start, free end).
  startId: z.string().optional(),
  startPort: portSchema.optional(),
  startAttachment: pointSchema.optional(),
  endId: z.string().optional(),
  endPort: portSchema.optional(),
  endAttachment: pointSchema.optional(),
  startX: z.number().optional(),
  startY: z.number().optional(),
  endX: z.number().optional(),
  endY: z.number().optional(),
  waypoints: z.array(waypointSchema).optional(),
});

export const addImageInput = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
  /** Data URL (`data:image/png;base64,…`) OR an absolute local file path
   *  that the MCP server reads and base64-encodes itself. */
  src: z.string().min(1),
  color: colorSchema.default('#ffffff'),
  rotation: z.number().optional(),
});

export const addDrawingInput = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
  baseWidth: z.number().positive(),
  baseHeight: z.number().positive(),
  points: z.array(drawingPointSchema).min(1),
  color: colorSchema,
  thickness: z.number().positive().optional(),
  groupId: z.string().optional(),
  rotation: z.number().optional(),
});

// --- update / patch -------------------------------------------------------

/** Per-type patch shapes. The tool layer dispatches based on the existing
 *  element's `type` so the agent doesn't have to repeat it. */
export const updateShapePatch = addShapeInput.partial();
export const updateImagePatch = addImageInput.partial();
export const updateArrowPatch = addArrowInput.partial();
export const updateDrawingPatch = addDrawingInput.partial();

// --- connect ---------------------------------------------------------------

export const connectInput = z.object({
  collabUrl: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Base WebSocket URL of the collab server, e.g. ws://localhost:8787. ' +
      'Falls back to the DOKA_COLLAB_URL env var if omitted.',
    ),
  boardId: z
    .string()
    .min(1)
    .optional()
    .describe('Falls back to the DOKA_BOARD_ID env var if omitted.'),
  inviteToken: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Invite token copied from the host\'s Share dialog. Falls back to the ' +
      'DOKA_INVITE_TOKEN env var if omitted.',
    ),
  name: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('Display name shown to other peers. Falls back to DOKA_AGENT_NAME, then "AI Agent".'),
  controlledBy: z
    .string()
    .max(64)
    .optional()
    .describe('Who is driving the agent (shown in presence). Falls back to DOKA_CONTROLLED_BY.'),
});

export const createBoardInput = z.object({
  title: z.string().min(1).max(200),
  parentChapterId: z
    .string()
    .optional()
    .describe('Chapter or document id to insert under; defaults to the first document at root'),
  /** Auto-switch the agent's session to the newly-created board. Defaults
   *  to true since most agent flows are "create + populate". */
  switchTo: z.boolean().default(true),
});

export const switchBoardInput = z.object({
  boardId: z.string().min(1),
});

export const arrangeInput = z.object({
  ids: z.array(z.string()).min(1),
  direction: z.enum(['up', 'down', 'front', 'back']),
});

export const moveCursorInput = z.object({
  x: z.number().nullable(),
  y: z.number().nullable(),
});

export const setSelectionInput = z.object({
  ids: z.array(z.string()),
});

export const elementIdInput = z.object({ id: z.string().min(1) });

export const updateElementInput = z.object({
  id: z.string().min(1),
  patch: z.record(z.string(), z.unknown()),
});
