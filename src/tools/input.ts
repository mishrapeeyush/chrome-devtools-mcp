/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {execFile} from 'child_process';
import {promisify} from 'util';

import {logger} from '../logger.js';
import type {McpContext} from '../McpContext.js';
import {zod} from '../third_party/index.js';
import type {ElementHandle, KeyInput} from '../third_party/index.js';
import type {TextSnapshotNode} from '../types.js';
import {parseKey} from '../utils/keyboard.js';
import type {WaitForEventsResult} from '../WaitForHelper.js';

const execFileAsync = promisify(execFile);

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

    // Bezier easing: ease-in-out cubic
    const ease = (t: number): number =>
      t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

    const steps = Math.max(50, Math.round(durationMs / 20));
    const delayPerStep = durationMs / steps;

    // Move to start, press down
    await page.mouse.move(startX, startY);
    await page.mouse.down();

    for (let i = 1; i <= steps; i++) {
      const t = ease(i / steps);
      // Add natural hand tremor: small random jitter that grows then fades
      const jitter = Math.sin(i * 0.8) * 1.5 * (1 - Math.abs(t - 0.5) * 2);
      const nx = startX + (endX - startX) * t + (Math.random() - 0.5) * 2;
      const ny =
        startY + (endY - startY) * t + jitter + (Math.random() - 0.5) * 1.5;
      await page.mouse.move(nx, ny);
      await new Promise(resolve => setTimeout(resolve, delayPerStep));
    }

    // Hold at end for a moment before releasing (mimics human pause)
    await new Promise(resolve =>
      setTimeout(resolve, 150 + Math.random() * 100),
    );
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

export const x11PressAndHold = defineTool({
  name: 'x11_press_and_hold',
  description: `Performs a press-and-hold interaction using real X11 OS-level mouse events via xdotool on the Xvfb display. Unlike press_and_hold (which uses CDP), this sends genuine hardware-level events that the browser treats as real user input (isTrusted=true, no CDP markers). Use this for strict behavioral CAPTCHAs like Walmart's PerimeterX HUMAN Challenge that detect CDP automation. Requires the pod to have xdotool installed and DISPLAY set (standard in the novnc image). Coordinates are in browser viewport pixels — same as click_at coordinates.`,
  annotations: {
    category: ToolCategory.INPUT,
    readOnlyHint: false,
  },
  schema: {
    x: zod.number().describe('X coordinate in browser viewport pixels'),
    y: zod.number().describe('Y coordinate in browser viewport pixels'),
    durationMs: zod
      .number()
      .optional()
      .describe('Hold duration in milliseconds (default 5000). Use 6000+ for strict CAPTCHAs.'),
    display: zod
      .string()
      .optional()
      .describe('X11 display to use (default ":99" — the Xvfb display in the novnc pod)'),
    screenOffsetX: zod
      .number()
      .optional()
      .describe('Additional X offset to convert viewport coords to screen coords (default 0). Compute as window.screenLeft.'),
    screenOffsetY: zod
      .number()
      .optional()
      .describe('Additional Y offset to convert viewport coords to screen coords. Compute as window.screenTop + (window.outerHeight - window.innerHeight). Typical Chrome on Xvfb: 72.'),
  },
  blockedByDialog: false,
  verifyFilesSchema: [],
  handler: async (request, response) => {
    const {x, y, durationMs = 5000, display = ':99', screenOffsetX = 0, screenOffsetY = 0} = request.params;
    const env = {...process.env, DISPLAY: display};

    // Convert viewport coordinates to Xvfb screen coordinates.
    // xdotool operates in screen space; take_screenshot returns viewport space.
    // The Chrome window's viewport top-left on screen = screenTop + (outerH - innerH).
    const sx = x + screenOffsetX;
    const sy = y + screenOffsetY;
    const holdSec = (durationMs / 1000).toFixed(2);

    // Approach from a natural offset, ease-in to the target, then hold.
    // All waypoints are clamped to >=0 so xdotool doesn't error on negative coords.
    const clamp = (v: number) => Math.max(0, Math.round(v));
    const startX = clamp(sx - 50 + Math.random() * 30);
    const startY = clamp(sy + 20 + Math.random() * 15);

    const approachArgs: string[] = ['mousemove', '--sync', String(startX), String(startY)];
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
      approachArgs.push(
        'mousemove', '--sync',
        String(clamp(startX + (sx - startX) * ease)),
        String(clamp(startY + (sy - startY) * ease)),
      );
    }

    const args = [
      ...approachArgs,
      'mousedown', '1',
      'sleep', holdSec,
      'mouseup', '1',
    ];

    try {
      await execFileAsync('xdotool', args, {env});
      response.appendResponseLine(
        `x11_press_and_hold completed at viewport (${x}, ${y}) → screen (${sx}, ${sy}) for ${durationMs}ms via xdotool on ${display}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      response.appendResponseLine(
        `x11_press_and_hold failed: ${msg}. Is xdotool installed and DISPLAY=${display} correct?`,
      );
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
