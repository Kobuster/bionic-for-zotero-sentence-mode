/* eslint-disable no-restricted-globals */
import { wait } from "zotero-plugin-toolkit";
import { computeFont } from "../utils/font";

import type {
  PDFPage,
  CanvasGraphics,
  InternalRenderTask,
  Glyph,
} from "./typings/pdfViewer";

declare const PDFViewerApplication: _ZoteroTypes.Reader.PDFViewerApplication;

declare const pdfjsLib: _ZoteroTypes.Reader.pdfjs;

let intentStatesPrototype: any;

let firstRenderTriggered = false;

function main() {
  patchIntentStatesGet();

  // If the first render is not triggered in 3 seconds, trigger a refresh again
  setTimeout(() => {
    if (!firstRenderTriggered) {
      refresh();
    }
  }, 3000);
}

main();

async function patchIntentStatesGet(pageIndex = 0) {
  await PDFViewerApplication?.pdfViewer?.firstPagePromise;
  await wait.waitUtilAsync(
    () =>
      !!PDFViewerApplication?.pdfViewer?._pages &&
      !!PDFViewerApplication?.pdfViewer?._pages[pageIndex],
    100,
    10000,
  );
  const page = PDFViewerApplication.pdfViewer!._pages![pageIndex] as PDFPage;
  // @ts-ignore Prototypes are not typed
  intentStatesPrototype = page.pdfPage._intentStates.__proto__;
  const original_get = intentStatesPrototype.get;
  intentStatesPrototype.__original_get = original_get;
  intentStatesPrototype.get = function (intent: any) {
    const ret = original_get.apply(this, [intent]);
    if (ret && typeof ret === "object" && ret.renderTasks) {
      _log("Intent", intent, ret);
      patchRenderTasksAdd(ret.renderTasks);
    }
    return ret;
  };
  // Refresh the page to apply the patch
  refresh();
}

function unPatchIntentStatesGet() {
  if (intentStatesPrototype.__original_get) {
    intentStatesPrototype.get = intentStatesPrototype.__original_get;
    delete intentStatesPrototype.__original_get;
  }
}

function patchRenderTasksAdd(renderTasks: Set<InternalRenderTask>) {
  const original_add = renderTasks.add;
  renderTasks.add = function (renderTask) {
    _log("Adding render task", renderTask);
    wait
      .waitUtilAsync(() => renderTask.gfx, 100, 10000)
      .then(() => {
        // Initialize bionic state for this specific renderTask
        if (!(renderTask as any)._bionicState) {
          (renderTask as any)._bionicState = {
            boldRemainingChars: 0,
          };
        }
        patchCanvasGraphicsShowText(renderTask.gfx.__proto__, renderTask);
        renderTasks.add = original_add;
        unPatchIntentStatesGet();
      });
    return original_add.apply(this, [renderTask]);
  };
}

function patchCanvasGraphicsShowText(
  canvasGraphicsPrototype: typeof CanvasGraphics & {
    __showTextPatched?: boolean;
    ctx: CanvasRenderingContext2D;
  },
  renderTask: InternalRenderTask & {
    _bionicState?: {
      boldRemainingChars: number;
    };
  },
) {
  if (canvasGraphicsPrototype.__showTextPatched) {
    return;
  }
  firstRenderTriggered = true;
  canvasGraphicsPrototype.__showTextPatched = true;
  // @ts-ignore Runtime generated method on prototype
  const original_showText = canvasGraphicsPrototype[pdfjsLib.OPS.showText];
  _log("Patching showText", canvasGraphicsPrototype);
  // @ts-ignore Runtime generated method on prototype
  canvasGraphicsPrototype[pdfjsLib.OPS.showText] = function (glyphs: Glyph[]) {
    if (!window.__BIONIC_READER_ENABLED) {
      return original_showText.apply(this, [glyphs]);
    }

    const opacityContrast = window.__BIONIC_OPACITY_CONTRAST || 1;

    const weightContrast = window.__BIONIC_WEIGHT_CONTRAST || 1;
    const weightOffset = window.__BIONIC_WEIGHT_OFFSET || 0;

    const savedFont = this.ctx.font;
    const savedOpacity = this.ctx.globalAlpha;

    const { bold, light } = computeFont({
      font: savedFont,
      alpha: savedOpacity,
      opacityContrast,
      weightContrast,
      weightOffset,
    });

    const bionicState = renderTask._bionicState!;
    const { newGlyphData, updatedState } = computeBionicGlyphs(
      glyphs,
      bionicState,
    );
    // Update the bionic state on the renderTask for the next call
    renderTask._bionicState = updatedState;

    for (const { glyphs: newG, isBold } of newGlyphData) {
      this.ctx.font = isBold ? bold.font : light.font;
      // If use greater contrast is enabled, set text opacity to less than 1
      if (opacityContrast > 1 && !isBold) {
        this.ctx.globalAlpha = light.alpha;
      }
      original_showText.apply(this, [newG]);
      this.ctx.font = savedFont;
      this.ctx.globalAlpha = savedOpacity;
    }

    return undefined;
  };
  _log("Patched showText", window.__BIONIC_READER_ENABLED);
  if (window.__BIONIC_READER_ENABLED) {
    refresh();
  }
}

function computeBionicGlyphs(
  glyphs: Glyph[],
  currentState: { boldRemainingChars: number },
) {
  const newGlyphData: {
    glyphs: Glyph[];
    isBold: boolean;
  }[] = [];

  const parsingOffset = window.__BIONIC_PARSING_OFFSET || 0;

  // Regex for major segment endings (periods, question marks, exclamation points, ellipsis)
  const MAJOR_SEGMENT_PUNCTUATION_REGEX = /[.?!\u2026]/u;
  // Regex for space or zero-width space (from <EMPTY>)
  const SPACE_OR_EMPTY_REGEX = / |\u2060/u;

  function getStr(glyph: Glyph) {
    if (typeof glyph === "number") {
      if (glyph < -100) {
        return " "; // Represents a space or line break
      } else {
        return "<EMPTY>"; // Represents an empty glyph, often zero-width space
      }
    }
    return glyph.unicode;
  }

  // Use local state variable for this chunk processing, initialized from currentState
  let boldRemainingChars = currentState.boldRemainingChars;

  for (let i = 0; i < glyphs.length; i++) {
    const glyph = glyphs[i];
    const str = getStr(glyph);
    let isBold = false;

    // If we are currently in an offset-bolding sequence after a sentence ending
    if (boldRemainingChars > 0) {
      isBold = true;
      boldRemainingChars--;
    } else {
      // Not currently bolding by offset, check if this character triggers new bolding
      const nextStr = i + 1 < glyphs.length ? getStr(glyphs[i + 1]) : null;

      // Check for sentence-ending punctuation
      if (MAJOR_SEGMENT_PUNCTUATION_REGEX.test(str)) {
        isBold = true; // The punctuation itself is bolded
        // Apply offset if followed by a space or zero-width space
        if (nextStr && SPACE_OR_EMPTY_REGEX.test(nextStr)) {
          boldRemainingChars = (parsingOffset || 0) + 5;
        } else if (nextStr === null) {
          // If punctuation is the last character in the chunk, assume it's followed by a space
          boldRemainingChars = (parsingOffset || 0) + 5;
        }
      }
    }

    newGlyphData.push({
      glyphs: glyphs.slice(i, i + 1),
      isBold: isBold,
    });
  }

  // Return the updated state to be stored on the renderTask for the next call
  return {
    newGlyphData,
    updatedState: { boldRemainingChars: boldRemainingChars },
  };
}

function refresh() {
  PDFViewerApplication.pdfViewer?.cleanup();
  PDFViewerApplication.pdfViewer?.refresh();
}

function _log(...args: any[]) {
  if (__env__ === "development") {
    console.log("[Bionic for Zotero]", ...args);
  }
}
