/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {logger} from '../logger.js';
import type {McpContext} from '../McpContext.js';
import {zod} from '../third_party/index.js';
import type {ElementHandle, KeyInput} from '../third_party/index.js';
import type {TextSnapshotNode} from '../types.js';
import {
  humanMouseMoveWithBaseline,
  installBehaviorBaselineProbe,
  normalizedHumanClick,
  puppeteerMouseClickable,
  readBehaviorBaselineProbe,
} from '../utils/behaviorBaseline.js';
import {
  humanMouseMove,
  randomApproachStart,
  randomPointInBox,
  sleep,
} from '../utils/humanMouse.js';
import {parseKey} from '../utils/keyboard.js';
import type {WaitForEventsResult} from '../WaitForHelper.js';

import {ToolCategory} from './categories.js';
import type {ContextPage} from './ToolDefinition.js';
import {definePageTool, defineTool} from './ToolDefinition.js';

const dblClickSchema = zod
  .boolean()
  .optional()
  .describe('Set to true for double clicks. Default is false.');

const includeSnapshotSchema = zod
  .boolean()
  .optional()
  .describe('Whether to include a snapshot in the response. Default is false.');

const submitKeySchema = zod
  .string()
  .optional()
  .describe(
    'Optional key to press after typing. E.g., "Enter", "Tab", "Escape"',
  );

function handleActionError(error: unknown, uid: string) {
  logger('failed to act using a locator', error);
  throw new Error(
    `Failed to interact with the element with uid ${uid}. The element did not become interactive within the configured timeout.`,
    {
      cause: error,
    },
  );
}

async function selectNativeSelectOption(handle: ElementHandle<Element>) {
  const selectHandle = await handle.evaluateHandle(node => {
    if (!(node instanceof HTMLOptionElement)) {
      return null;
    }

    const select = node.closest('select');
    if (!select || select.multiple || select.disabled || node.disabled) {
      return null;
    }

    const parentElement = node.parentElement;
    if (
      parentElement instanceof HTMLOptGroupElement &&
      parentElement.disabled
    ) {
      return null;
    }

    return select;
  });
  try {
    const select = selectHandle.asElement() as ElementHandle<Element> | null;
    if (!select) {
      return false;
    }

    const valueHandle = await handle.getProperty('value');
    try {
      const value = await valueHandle.jsonValue();
      if (typeof value !== 'string') {
        return false;
      }
      await select.asLocator().fill(value);
    } finally {
      void valueHandle.dispose();
    }
    return true;
  } finally {
    void selectHandle.dispose();
  }
}

export const click = definePageTool({
  name: 'click',
  description: `Clicks on the provided element`,
  annotations: {
    category: ToolCategory.INPUT,
    readOnlyHint: false,
  },
  schema: {
    uid: zod
      .string()
      .describe(
        'The uid of an element on the page from the page content snapshot',
      ),
    dblClick: dblClickSchema,
    includeSnapshot: includeSnapshotSchema,
  },
  blockedByDialog: true,
  verifyFilesSchema: [],
  handler: async (request, response) => {
    const uid = request.params.uid;
    const handle = await request.page.getElementByUid(uid);
    const aXNode = request.page.getAXNodeByUid(uid);
    const shouldSelectNativeOption =
      !request.params.dblClick && aXNode?.role === 'option';
    try {
      const result = await request.page.waitForEventsAfterAction(async () => {
        if (
          shouldSelectNativeOption &&
          (await selectNativeSelectOption(handle))
        ) {
          return;
        }

        await handle.asLocator().click({
          count: request.params.dblClick ? 2 : 1,
        });
      });
      response.appendResponseLine(
        request.params.dblClick
          ? `Successfully double clicked on the element`
          : `Successfully clicked on the element`,
      );
      response.attachWaitForResult(result);
      if (request.params.includeSnapshot) {
        response.includeSnapshot();
      }
    } catch (error) {
      handleActionError(error, uid);
    } finally {
      void handle.dispose();
    }
  },
});

export const behaviorBaseline = definePageTool({
  name: 'behavior_baseline',
  description: `Install or finalize a behavioral rhythm probe on the current page for DataDome baseline normalization. Call action=install at the start of travel-guide dwell, perform scroll/hover fidget for 8-12s, then action=finalize before click_human on Search. The captured move/click timing profile is reused so the search click matches the session baseline instead of bot-constant speed.`,
  annotations: {
    category: ToolCategory.INPUT,
    readOnlyHint: false,
  },
  schema: {
    action: zod
      .enum(['install', 'finalize', 'clear'])
      .describe(
        'install: start recording mousemove/click timing on this page. finalize: read probe metrics and store session baseline. clear: discard stored baseline.',
      ),
  },
  blockedByDialog: false,
  verifyFilesSchema: [],
  handler: async (request, response, context) => {
    const page = request.page.pptrPage;
    if (request.params.action === 'clear') {
      context.clearBehaviorBaseline();
      response.appendResponseLine('Behavior baseline cleared for this session.');
      return;
    }
    if (request.params.action === 'install') {
      await installBehaviorBaselineProbe(page);
      response.appendResponseLine(
        'Behavior baseline probe installed. Dwell 8-12s with human_hover_path and scroll, then call behavior_baseline action=finalize before click_human.',
      );
      return;
    }
    const baseline = await readBehaviorBaselineProbe(page);
    if (!baseline) {
      throw new Error(
        'No baseline probe data — call behavior_baseline action=install first, dwell on the page, then finalize.',
      );
    }
    context.setBehaviorBaseline(baseline);
    response.appendResponseLine(
      `Baseline captured: meanMoveIntervalMs=${Math.round(baseline.meanMoveIntervalMs)}, variance=${Math.round(baseline.moveIntervalVariance)}, meanClickPauseMs=${Math.round(baseline.meanClickPauseMs)}, moveSamples=${baseline.moveSampleCount}. Use click_human with useBaseline=true on Search.`,
    );
  },
});

export const clickHuman = definePageTool({
  name: 'click_human',
  description: `Clicks an element using a human-like mouse trajectory (Gaussian-smoothed path or baseline-normalized Bezier when a behavior baseline was captured via behavior_baseline). REQUIRED for high-scrutiny actions on DataDome/PerimeterX sites (e.g. Expedia search button) where \`click\` triggers intent-based bot detection. Workflow: behavior_baseline install → dwell/fidget → behavior_baseline finalize → click_human on Search.`,
  annotations: {
    category: ToolCategory.INPUT,
    readOnlyHint: false,
  },
  schema: {
    uid: zod
      .string()
      .describe(
        'The uid of an element on the page from the page content snapshot',
      ),
    durationMs: zod
      .number()
      .optional()
      .describe(
        'Mouse travel duration in ms (default 900). Use 1200-1800 for search buttons.',
      ),
    preHoverMs: zod
      .number()
      .optional()
      .describe(
        'Pause at target before mousedown in ms (default 200-450 random).',
      ),
    useBaseline: zod
      .boolean()
      .optional()
      .describe(
        'When true (default), use behavior_baseline profile if captured. Set false to force generic Gaussian path.',
      ),
    includeSnapshot: includeSnapshotSchema,
  },
  blockedByDialog: true,
  verifyFilesSchema: [],
  handler: async (request, response, context) => {
    const uid = request.params.uid;
    const handle = await request.page.getElementByUid(uid);
    try {
      const box = await handle.boundingBox();
      if (!box) {
        throw new Error(
          `Element ${uid} has no bounding box — cannot human-click.`,
        );
      }
      const durationMs = request.params.durationMs ?? 900;
      const preHoverMs =
        request.params.preHoverMs ??
        Math.round(200 + Math.random() * 250);
      const useBaseline = request.params.useBaseline ?? true;
      const baseline =
        useBaseline ? context.getBehaviorBaseline() : undefined;
      const page = request.page.pptrPage;
      const mouse = page.mouse;
      let clickSummary = '';

      const result = await request.page.waitForEventsAfterAction(async () => {
        if (baseline) {
          const target = await normalizedHumanClick(
            puppeteerMouseClickable(mouse),
            box,
            baseline,
            durationMs,
            preHoverMs,
          );
          clickSummary = `Baseline-normalized click at (${target.x},${target.y}) meanInterval=${Math.round(baseline.meanMoveIntervalMs)}ms`;
        } else {
          const target = randomPointInBox(box.x, box.y, box.width, box.height);
          const start = randomApproachStart(target.x, target.y);
          await humanMouseMove(
            mouse,
            start.x,
            start.y,
            target.x,
            target.y,
            durationMs,
          );
          await sleep(preHoverMs);
          await mouse.click(target.x, target.y);
          clickSummary = `Human-like click at (${target.x},${target.y}) after ${durationMs}ms approach`;
        }
      });
      response.appendResponseLine(clickSummary);
      response.attachWaitForResult(result);
      if (request.params.includeSnapshot) {
        response.includeSnapshot();
      }
    } catch (error) {
      handleActionError(error, uid);
    } finally {
      void handle.dispose();
    }
  },
});

export const humanHoverPath = definePageTool({
  name: 'human_hover_path',
  description: `Moves the mouse along a human-like curved path to an element and hovers (no click). Use for pre-search "fidget" micro-interactions on booking forms — hover date field, travelers, nearby links before click_human on Search.`,
  annotations: {
    category: ToolCategory.INPUT,
    readOnlyHint: false,
  },
  schema: {
    uid: zod.string().describe('Element uid to hover over'),
    durationMs: zod
      .number()
      .optional()
      .describe('Travel duration in ms (default 700)'),
    dwellMs: zod
      .number()
      .optional()
      .describe('Hover pause at target in ms (default 400-900 random)'),
    includeSnapshot: includeSnapshotSchema,
  },
  blockedByDialog: true,
  verifyFilesSchema: [],
  handler: async (request, response, context) => {
    const uid = request.params.uid;
    const handle = await request.page.getElementByUid(uid);
    try {
      const box = await handle.boundingBox();
      if (!box) {
        throw new Error(`Element ${uid} has no bounding box.`);
      }
      const target = randomPointInBox(box.x, box.y, box.width, box.height);
      const start = randomApproachStart(target.x, target.y);
      const durationMs = request.params.durationMs ?? 700;
      const dwellMs =
        request.params.dwellMs ?? Math.round(400 + Math.random() * 500);
      const baseline = context.getBehaviorBaseline();
      const page = request.page.pptrPage;

      const result = await request.page.waitForEventsAfterAction(async () => {
        if (baseline) {
          await humanMouseMoveWithBaseline(
            page.mouse,
            start.x,
            start.y,
            target.x,
            target.y,
            baseline,
            durationMs,
          );
        } else {
          await humanMouseMove(
            page.mouse,
            start.x,
            start.y,
            target.x,
            target.y,
            durationMs,
          );
        }
        await sleep(dwellMs);
      });

      response.appendResponseLine(
        baseline
          ? `Baseline-normalized hover to (${target.x},${target.y}), dwelled ${dwellMs}ms`
          : `Human hover path to (${target.x},${target.y}), dwelled ${dwellMs}ms`,
      );
      response.attachWaitForResult(result);
      if (request.params.includeSnapshot) {
        response.includeSnapshot();
      }
    } catch (error) {
      handleActionError(error, uid);
    } finally {
      void handle.dispose();
    }
  },
});

export const clickAt = definePageTool({
  name: 'click_at',
  description: `Clicks at the provided page coordinates (x, y). Essential for canvas-rendered UIs (Konva, WebGL, Chart.js, seat maps) where elements have no uid. Workflow: call get_element_bbox to get the canvas bounding box, compute the target pixel within the canvas, then call click_at(x, y). Always prefer click_at over evaluate_script for canvas interaction.`,
  annotations: {
    category: ToolCategory.INPUT,
    readOnlyHint: false,
    conditions: ['experimentalVision'],
  },
  schema: {
    x: zod.number().describe('The x coordinate'),
    y: zod.number().describe('The y coordinate'),
    dblClick: dblClickSchema,
    includeSnapshot: includeSnapshotSchema,
  },
  blockedByDialog: true,
  verifyFilesSchema: [],
  handler: async (request, response) => {
    const page = request.page;
    const result = await page.waitForEventsAfterAction(async () => {
      await page.pptrPage.mouse.click(request.params.x, request.params.y, {
        count: request.params.dblClick ? 2 : 1,
      });
    });
    response.appendResponseLine(
      request.params.dblClick
        ? `Successfully double clicked at the coordinates`
        : `Successfully clicked at the coordinates`,
    );
    response.attachWaitForResult(result);
    if (request.params.includeSnapshot) {
      response.includeSnapshot();
    }
  },
});

export const hover = definePageTool({
  name: 'hover',
  description: `Hover over the provided element`,
  annotations: {
    category: ToolCategory.INPUT,
    readOnlyHint: false,
  },
  schema: {
    uid: zod
      .string()
      .describe(
        'The uid of an element on the page from the page content snapshot',
      ),
    includeSnapshot: includeSnapshotSchema,
  },
  blockedByDialog: true,
  verifyFilesSchema: [],
  handler: async (request, response) => {
    const uid = request.params.uid;
    const handle = await request.page.getElementByUid(uid);
    try {
      const result = await request.page.waitForEventsAfterAction(async () => {
        await handle.asLocator().hover();
      });
      response.appendResponseLine(`Successfully hovered over the element`);
      response.attachWaitForResult(result);
      if (request.params.includeSnapshot) {
        response.includeSnapshot();
      }
    } catch (error) {
      handleActionError(error, uid);
    } finally {
      void handle.dispose();
    }
  },
});

// The AXNode for an option doesn't contain its `value`. We set text content of the option as value.
// If the form is a combobox, we need to find the correct option by its text value.
// To do that, loop through the children while checking which child's text matches the requested value (requested value is actually the text content).
// When the correct option is found, use the element handle to get the real value.
async function selectOption(
  handle: ElementHandle,
  aXNode: TextSnapshotNode,
  value: string,
) {
  let optionFound = false;
  for (const child of aXNode.children) {
    if (child.role === 'option' && child.name === value && child.value) {
      optionFound = true;
      const childHandle = await child.elementHandle();
      if (childHandle) {
        try {
          const childValueHandle = await childHandle.getProperty('value');
          try {
            const childValue = await childValueHandle.jsonValue();
            if (childValue) {
              await handle.asLocator().fill(childValue.toString());
            }
          } finally {
            void childValueHandle.dispose();
          }
          break;
        } finally {
          void childHandle.dispose();
        }
      }
    }
  }
  if (!optionFound) {
    throw new Error(`Could not find option with text "${value}"`);
  }
}

function hasOptionChildren(aXNode: TextSnapshotNode) {
  return aXNode.children.some(child => child.role === 'option');
}

async function fillFormElement(
  uid: string,
  value: string,
  context: McpContext,
  page: ContextPage,
) {
  const handle = await page.getElementByUid(uid);
  try {
    const aXNode = context.getAXNodeByUid(uid);
    // We assume that combobox needs to be handled as select if it has
    // role='combobox' and option children.
    if (aXNode && aXNode.role === 'combobox' && hasOptionChildren(aXNode)) {
      await selectOption(handle, aXNode, value);
    } else {
      const isToggle = await handle.evaluate(el => {
        if (el instanceof HTMLInputElement) {
          return el.type === 'checkbox' || el.type === 'radio';
        }
        const role = el.getAttribute('role');
        return role === 'checkbox' || role === 'radio' || role === 'switch';
      });

      if (isToggle) {
        if (['true', 'false'].includes(value)) {
          await handle.asLocator().fill(value === 'true');
        } else {
          throw new Error(
            `Checkboxes, radio boxes and toggles require "true" or "false" value, but ${value} was used`,
          );
        }
      } else {
        // Increase timeout for longer input values.
        const timeoutPerChar = 10; // ms
        const fillTimeout =
          page.pptrPage.getDefaultTimeout() + value.length * timeoutPerChar;
        await handle.asLocator().setTimeout(fillTimeout).fill(value);
      }
    }
  } catch (error) {
    handleActionError(error, uid);
  } finally {
    void handle.dispose();
  }
}

export const fill = definePageTool({
  name: 'fill',
  description: `Type text into an input, text area or select an option from a <select> element.`,
  annotations: {
    category: ToolCategory.INPUT,
    readOnlyHint: false,
  },
  schema: {
    uid: zod
      .string()
      .describe(
        'The uid of an element on the page from the page content snapshot',
      ),
    value: zod
      .string()
      .describe(
        'The value to fill in. "true" or "false" for checkboxes and toggles, "true" for radio buttons.',
      ),
    includeSnapshot: includeSnapshotSchema,
  },
  blockedByDialog: true,
  verifyFilesSchema: [],
  handler: async (request, response, context) => {
    const page = request.page;
    const result = await page.waitForEventsAfterAction(async () => {
      await fillFormElement(
        request.params.uid,
        request.params.value,
        context as McpContext,
        page,
      );
    });
    response.appendResponseLine(`Successfully filled out the element`);
    response.attachWaitForResult(result);
    if (request.params.includeSnapshot) {
      response.includeSnapshot();
    }
  },
});

export const typeText = definePageTool({
  name: 'type_text',
  description: `Type text using keyboard into a previously focused input`,
  annotations: {
    category: ToolCategory.INPUT,
    readOnlyHint: false,
  },
  schema: {
    text: zod.string().describe('The text to type'),
    submitKey: submitKeySchema,
  },
  blockedByDialog: true,
  verifyFilesSchema: [],
  handler: async (request, response) => {
    const page = request.page;
    const result = await page.waitForEventsAfterAction(async () => {
      await page.pptrPage.keyboard.type(request.params.text);
      if (request.params.submitKey) {
        await page.pptrPage.keyboard.press(
          request.params.submitKey as KeyInput,
        );
      }
    });
    response.appendResponseLine(
      `Typed text "${request.params.text}${request.params.submitKey ? ` + ${request.params.submitKey}` : ''}"`,
    );
    response.attachWaitForResult(result);
  },
});

export const drag = definePageTool({
  name: 'drag',
  description: `Drag an element onto another element`,
  annotations: {
    category: ToolCategory.INPUT,
    readOnlyHint: false,
  },
  schema: {
    from_uid: zod.string().describe('The uid of the element to drag'),
    to_uid: zod.string().describe('The uid of the element to drop into'),
    includeSnapshot: includeSnapshotSchema,
  },
  blockedByDialog: true,
  verifyFilesSchema: [],
  handler: async (request, response) => {
    const fromHandle = await request.page.getElementByUid(
      request.params.from_uid,
    );
    const toHandle = await request.page.getElementByUid(request.params.to_uid);
    try {
      const result = await request.page.waitForEventsAfterAction(async () => {
        await fromHandle.drag(toHandle);
        await new Promise(resolve => setTimeout(resolve, 50));
        await toHandle.drop(fromHandle);
      });
      response.appendResponseLine(`Successfully dragged an element`);
      response.attachWaitForResult(result);
      if (request.params.includeSnapshot) {
        response.includeSnapshot();
      }
    } finally {
      void fromHandle.dispose();
      void toHandle.dispose();
    }
  },
});

export const fillForm = definePageTool({
  name: 'fill_form',
  description: `Fill out multiple form elements (inputs, selects, checkboxes, radios) at once. ALWAYS prefer this tool over multiple individual 'fill' or 'click' calls when interacting with forms. It is significantly faster, more reliable, and reduces turn count. Example: Fill username, password, and check "Remember Me" in one call.`,
  annotations: {
    category: ToolCategory.INPUT,
    readOnlyHint: false,
  },
  schema: {
    elements: zod
      .array(
        // eslint-disable-next-line @local/enforce-zod-schema
        zod.object({
          uid: zod.string().describe('The uid of the element to fill out'),
          value: zod
            .string()
            .describe(
              'Value for the element. "true" or "false" for checkboxes and toggles, "true" for radio buttons.',
            ),
        }),
      )
      .describe('Elements from snapshot to fill out.'),
    includeSnapshot: includeSnapshotSchema,
  },
  blockedByDialog: true,
  verifyFilesSchema: [],
  handler: async (request, response, context) => {
    const page = request.page;
    let lastResult: WaitForEventsResult = {};
    for (const element of request.params.elements) {
      lastResult = await page.waitForEventsAfterAction(async () => {
        await fillFormElement(
          element.uid,
          element.value,
          context as McpContext,
          page,
        );
      });
    }
    response.appendResponseLine(`Successfully filled out the form`);
    response.attachWaitForResult(lastResult);
    if (request.params.includeSnapshot) {
      response.includeSnapshot();
    }
  },
});

export const uploadFile = definePageTool({
  name: 'upload_file',
  description: 'Upload a file through a provided element.',
  annotations: {
    category: ToolCategory.INPUT,
    readOnlyHint: false,
  },
  schema: {
    uid: zod
      .string()
      .describe(
        'The uid of the file input element or an element that will open file chooser on the page from the page content snapshot',
      ),
    filePath: zod.string().describe('The local path of the file to upload'),
    includeSnapshot: includeSnapshotSchema,
  },
  blockedByDialog: true,
  verifyFilesSchema: ['filePath'],
  handler: async (request, response, _context) => {
    const {uid, filePath} = request.params;
    const handle = (await request.page.getElementByUid(
      uid,
    )) as ElementHandle<HTMLInputElement>;
    try {
      try {
        await handle.uploadFile(filePath);
      } catch {
        // Some sites use a proxy element to trigger file upload instead of
        // a type=file element. In this case, we want to default to
        // Page.waitForFileChooser() and upload the file this way.
        try {
          const [fileChooser] = await Promise.all([
            request.page.pptrPage.waitForFileChooser({timeout: 3000}),
            handle.asLocator().click(),
          ]);
          await fileChooser.accept([filePath]);
        } catch {
          throw new Error(
            `Failed to upload file. The element could not accept the file directly, and clicking it did not trigger a file chooser.`,
          );
        }
      }
      if (request.params.includeSnapshot) {
        response.includeSnapshot();
      }
      response.appendResponseLine(`File uploaded from ${filePath}.`);
    } finally {
      void handle.dispose();
    }
  },
});

export const pressKey = definePageTool({
  name: 'press_key',
  description: `Press a key or key combination. Use this when other input methods like fill() cannot be used (e.g., keyboard shortcuts, navigation keys, or special key combinations).`,
  annotations: {
    category: ToolCategory.INPUT,
    readOnlyHint: false,
  },
  schema: {
    key: zod
      .string()
      .describe(
        'A key or a combination (e.g., "Enter", "Control+A", "Control++", "Control+Shift+R"). Modifiers: Control, Shift, Alt, Meta',
      ),
    includeSnapshot: includeSnapshotSchema,
  },
  blockedByDialog: true,
  verifyFilesSchema: [],
  handler: async (request, response) => {
    const page = request.page;
    const tokens = parseKey(request.params.key);
    const [key, ...modifiers] = tokens;

    const result = await page.waitForEventsAfterAction(async () => {
      for (const modifier of modifiers) {
        await page.pptrPage.keyboard.down(modifier);
      }
      await page.pptrPage.keyboard.press(key);
      for (const modifier of modifiers.toReversed()) {
        await page.pptrPage.keyboard.up(modifier);
      }
    });

    response.appendResponseLine(
      `Successfully pressed key: ${request.params.key}`,
    );
    response.attachWaitForResult(result);
    if (request.params.includeSnapshot) {
      response.includeSnapshot();
    }
  },
});

export const getElementBbox = definePageTool({
  name: 'get_element_bbox',
  description: `Returns the bounding box {x, y, width, height} of an element in page coordinates. Use this to locate canvas-rendered UIs (seat maps, charts, Konva/WebGL canvases) where interaction must be done via click_at(x, y). Typical workflow: 1) call get_element_bbox on the canvas uid, 2) compute target coordinates within the canvas, 3) call click_at(x, y).`,
  annotations: {
    category: ToolCategory.INPUT,
    readOnlyHint: true,
  },
  schema: {
    uid: zod
      .string()
      .describe(
        'The uid of an element on the page from the page content snapshot',
      ),
  },
  blockedByDialog: false,
  verifyFilesSchema: [],
  handler: async (request, response) => {
    const uid = request.params.uid;
    const handle = await request.page.getElementByUid(uid);
    try {
      const box = await handle.boundingBox();
      if (!box) {
        response.appendResponseLine(
          `Element ${uid} has no bounding box — it may be hidden or not rendered in the viewport.`,
        );
        return;
      }
      response.appendResponseLine(
        JSON.stringify({
          x: Math.round(box.x),
          y: Math.round(box.y),
          width: Math.round(box.width),
          height: Math.round(box.height),
          centerX: Math.round(box.x + box.width / 2),
          centerY: Math.round(box.y + box.height / 2),
        }),
      );
    } finally {
      void handle.dispose();
    }
  },
});

export const mouseDragHuman = definePageTool({
  name: 'mouse_drag_human',
  description: `Performs a human-like press-and-hold drag from (startX, startY) to (endX, endY) over durationMs milliseconds, using bezier-curved intermediate points with randomised jitter. Use this for CAPTCHA press-and-hold sliders (Datadome, PerimeterX, Cloudflare turnstile sliders) where a straight-line drag is detected as a bot. The motion follows a natural acceleration/deceleration curve with slight wobble.`,
  annotations: {
    category: ToolCategory.INPUT,
    readOnlyHint: false,
  },
  schema: {
    startX: zod.number().describe('Start X coordinate in page pixels'),
    startY: zod.number().describe('Start Y coordinate in page pixels'),
    endX: zod.number().describe('End X coordinate in page pixels'),
    endY: zod.number().describe('End Y coordinate in page pixels'),
    durationMs: zod
      .number()
      .optional()
      .describe(
        'Total drag duration in milliseconds (default 2000). Increase for tighter CAPTCHA checks.',
      ),
  },
  blockedByDialog: false,
  verifyFilesSchema: [],
  handler: async (request, response) => {
    const {startX, startY, endX, endY, durationMs = 2000} = request.params;
    const page = request.page.pptrPage;

    await page.mouse.move(startX, startY);
    await page.mouse.down();

    await humanMouseMove(page.mouse, startX, startY, endX, endY, durationMs);

    await sleep(150 + Math.random() * 100);
    await page.mouse.up();

    response.appendResponseLine(
      `Human-like drag completed from (${startX},${startY}) to (${endX},${endY}) over ${durationMs}ms`,
    );
  },
});

export const pressAndHold = definePageTool({
  name: 'press_and_hold',
  description: `Performs a precise press-and-hold interaction on an element at (x, y) for durationMs milliseconds using CDP browser input events — NOT VNC mouse events. Use this for press-and-hold CAPTCHAs (Walmart, Akamai, PerimeterX) where VNC introduces timing jitter that causes the hold to fail even for real humans. The element is located by coordinates; the hold uses PointerEvent + MouseEvent with realistic pressure values. Returns success or an error message.`,
  annotations: {
    category: ToolCategory.INPUT,
    readOnlyHint: false,
  },
  schema: {
    x: zod.number().describe('X coordinate of the element center to hold'),
    y: zod.number().describe('Y coordinate of the element center to hold'),
    durationMs: zod
      .number()
      .optional()
      .describe('How long to hold in milliseconds (default 3000). Increase to 4000+ for strict CAPTCHAs.'),
  },
  blockedByDialog: false,
  verifyFilesSchema: [],
  handler: async (request, response) => {
    const {x, y, durationMs = 3000} = request.params;
    const page = request.page.pptrPage;

    // Use CDP Input.dispatchMouseEvent for timing-precise hold.
    // Adds realistic approach movement + micro-jitter during hold to satisfy
    // behavioral CAPTCHAs (PerimeterX HUMAN Challenge, Akamai) that track
    // mouse trajectory, not just button state.
    const client = await page.createCDPSession();
    try {
      const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

      // Approach: move from an offset position towards the button in ~10 steps
      const startX = x - 60 + Math.round(Math.random() * 40);
      const startY = y + 15 + Math.round(Math.random() * 20);
      const steps = 12;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        // Ease-in-out curve for natural deceleration near the target
        const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
        await client.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: Math.round(startX + (x - startX) * ease),
          y: Math.round(startY + (y - startY) * ease),
          button: 'none' as const,
          buttons: 0,
          modifiers: 0,
          pointerType: 'mouse' as const,
        });
        await sleep(8 + Math.round(Math.random() * 12));
      }

      // Press down
      await client.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: 'left' as const,
        buttons: 1,
        clickCount: 1,
        modifiers: 0,
        pointerType: 'mouse' as const,
        force: 0.5,
      });

      // Hold with micro-jitter to simulate natural hand tremor
      const jitterIntervalMs = 80;
      const jitterSteps = Math.floor(durationMs / jitterIntervalMs);
      for (let i = 0; i < jitterSteps; i++) {
        const jx = x + (Math.random() - 0.5) * 2;
        const jy = y + (Math.random() - 0.5) * 2;
        await client.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: Math.round(jx * 10) / 10,
          y: Math.round(jy * 10) / 10,
          button: 'left' as const,
          buttons: 1,
          modifiers: 0,
          pointerType: 'mouse' as const,
          force: 0.5,
        });
        await sleep(jitterIntervalMs);
      }

      // Release
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: 'left' as const,
        buttons: 0,
        clickCount: 1,
        modifiers: 0,
        pointerType: 'mouse' as const,
        force: 0,
      });

      response.appendResponseLine(
        `Press-and-hold completed at (${x}, ${y}) for ${durationMs}ms via CDP`,
      );
    } finally {
      await client.detach();
    }
  },
});

export const requestUserInput = defineTool({
  name: 'request_user_input',
  description: `Pause the session and ask the user for information that was not provided in the original task — for example, which seat row to pick, an OTP, a CAPTCHA answer, a password, or a yes/no confirmation. The session will be paused and the user's response will be injected when the session resumes. Use inputType "text" for open-ended answers, "otp" for one-time codes, "password" for sensitive values, "confirm" for yes/no choices. ALWAYS call this instead of guessing or making assumptions when a required decision is missing.`,
  annotations: {
    category: ToolCategory.INPUT,
    readOnlyHint: true,
  },
  schema: {
    prompt: zod
      .string()
      .describe('The question or instruction to display to the user'),
    inputType: zod
      .enum(['text', 'otp', 'password', 'confirm'])
      .describe(
        'The type of input expected: "text" for general answers, "otp" for one-time codes, "password" for sensitive values, "confirm" for yes/no',
      ),
  },
  blockedByDialog: false,
  verifyFilesSchema: [],
  handler: async (request, response) => {
    const {prompt, inputType} = request.params;
    response.appendResponseLine(
      `AWAITING_INPUT: ${JSON.stringify({prompt, inputType})}`,
    );
    response.appendResponseLine(
      `Session paused. Waiting for user input: ${prompt}`,
    );
  },
});
