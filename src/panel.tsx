import { Camera, Check, ChevronDown, TriangleAlert, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowBigRightDashIcon, type ArrowBigRightDashIconHandle } from "@/components/ui/arrow-big-right-dash";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Kbd } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import { MapPinIcon, type MapPinIconHandle } from "@/components/ui/map-pin";
import { Separator } from "@/components/ui/separator";
import { Slider, SliderValue } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { UndoDotIcon, type UndoDotIconHandle } from "@/components/ui/undo-dot";
import { UploadIcon, type UploadIconHandle } from "@/components/ui/upload";
import { CARD_STEPS } from "@/content/cardSteps";
import { cn } from "@/lib/utils";
import { InstructionsModal } from "./instructions-modal";
import { controls } from "../main.js";

const CONTROLS_HIDDEN_KEY = "iconMosaic.controlsHidden";

// Content for the bottom-left info card (Figma node 4992:24139), one entry
// per *assigned* Camera Target slot — up to CAMERA_TARGET_SLOT_COUNT (7) in
// main.js, but indexed here by position among whichever of those are
// actually assigned, not by raw slot index, so the card always has exactly
// as many steps as there are targets in use (assign 3, it's Step 1-3;
// assign 5, it's Step 1-5 — see activeTargetPosition's own comment at its
// call site for how a raw slot index gets translated to that). Swaps with
// state.cameraTargetActiveIndex so the card tracks whichever target is
// currently framed (manual 1-7 press, or the /scroll route easing through
// them on scroll). Content (step/title/text/iconPath) itself lives in
// src/content/cardSteps.ts (CARD_STEPS) — that's the CMS-editable half, kept
// separate from this file specifically so a future CMS integration only
// has to touch that module, not this component's layout/animation code.

type RevealPhase = "closed" | "entering" | "open" | "closing";
const MODAL_CLOSE_MS = 150; // keep in sync with --modal-close-dur in index.css

// Shared open/close lifecycle for anything driven by the --modal-open-dur/
// --modal-close-dur tokens (transitions.dev, 06-modal.md): mount in a
// pre-open state, flip to "open" on the next frame so the enter transition
// actually plays, and on close hold in "closing" for the CSS transition's
// duration before unmounting.
function useRevealPhase(visible: boolean, closeMs: number): RevealPhase {
  const [phase, setPhase] = useState<RevealPhase>(() => (visible ? "open" : "closed"));

  useEffect(() => {
    if (visible) {
      setPhase((p) => (p === "closed" ? "entering" : p === "closing" ? "open" : p));
    } else {
      setPhase((p) => (p === "closed" ? "closed" : "closing"));
    }
  }, [visible]);

  useEffect(() => {
    if (phase !== "entering") return;
    const id = requestAnimationFrame(() => setPhase("open"));
    return () => cancelAnimationFrame(id);
  }, [phase]);

  useEffect(() => {
    if (phase !== "closing") return;
    const id = window.setTimeout(() => setPhase("closed"), closeMs);
    return () => window.clearTimeout(id);
  }, [phase, closeMs]);

  return phase;
}

type TextSwapPhase = "rest" | "exit" | "enterStart";
const TEXT_SWAP_MS = 50; // keep in sync with --text-swap-dur in index.css

// Three-phase text/state swap (transitions.dev, 04-text-states-swap.md):
// exit the old value (blur + slide up + fade), swap to the new value while
// invisible and pre-positioned below (no transition), then release on the
// next frame so it eases back to rest. `value` can be any comparable state,
// not just text — the space-bar indicator drives its label AND its color
// off the same delayed `displayed` value so both change together, mid-swap.
function useTextSwap<T>(value: T, exitMs: number): { displayed: T; phase: TextSwapPhase } {
  const [displayed, setDisplayed] = useState(value);
  const [phase, setPhase] = useState<TextSwapPhase>("rest");

  useEffect(() => {
    if (value === displayed) return;
    setPhase("exit");
    const exitTimer = window.setTimeout(() => {
      setDisplayed(value);
      setPhase("enterStart");
    }, exitMs);
    return () => window.clearTimeout(exitTimer);
  }, [value, displayed, exitMs]);

  useEffect(() => {
    if (phase !== "enterStart") return;
    const id = requestAnimationFrame(() => setPhase("rest"));
    return () => cancelAnimationFrame(id);
  }, [phase]);

  return { displayed, phase };
}

type TextsRevealPhase = "hidden" | "shown" | "hiding" | "enterStart";
type TextsRevealDirection = "up" | "down";
const TEXTS_REVEAL_HIDE_MS = 300; // keep in sync with .t-stagger.is-hiding's --stagger-exit-dur in index.css

// Group text-block reveal (transitions.dev, 18-texts-reveal.md, adapted):
// unlike useTextSwap above (one value swapping in place), this fades a whole
// block of stacked lines out together, swaps to the new step's content while
// hidden, then plays the staggered blurred-rise entrance back in — used by
// the bottom-left info card's step/title/text, which all change together
// whenever the active Camera Target does. Takes the target *index* rather
// than an opaque value (contrast useTextSwap) specifically so it can compare
// old vs. new to derive `direction`: scrolling forward (index increasing)
// travels one way, scrolling backward the other — see the CSS's
// data-direction selectors for what that actually moves. This is a
// deliberate departure from the reference snippet's own "quiet fade, no
// Y-return" exit (which exists there specifically so *dismissing* something
// doesn't read as a reversed reveal) — here the whole point is to tie the
// motion's direction to the scroll gesture that caused it.
//
// `revealed` gates the very first entrance, reversibly (contrast
// useTextSwap, which has no such thing and always starts at rest): while
// false, phase sits at "hidden" — same pre-enter offset/opacity/blur as
// "enterStart" (see the CSS's is-entering selectors, which "hidden" maps to
// as well), just without the auto-advance-to-"shown" rAF that "enterStart"
// gets, so it holds there indefinitely instead of immediately playing. The
// moment `revealed` flips true, it's treated exactly like an index change —
// direction "down" (rises up from below, see the CSS's data-direction
// selectors), enterStart, then shown a frame later — so the bottom-left
// info card's first appearance plays the same staggered blurred-rise
// entrance a later step change does, timed to whatever caller-chosen moment
// `revealed` flips at, not simply on mount. If `revealed` later flips back
// to false (the card's own scroll-scrubbed intro reversing because the user
// scrolled back up past it), the second effect below plays that same motion
// in reverse — direction "up" (sinks back down, fading and re-blurring) —
// and settles at "hidden" again rather than continuing on to any particular
// index's entrance, ready to replay the entrance if `revealed` flips true
// once more.
function useTextsReveal(
  index: number,
  hideMs: number,
  revealed: boolean,
): { displayedIndex: number; phase: TextsRevealPhase; direction: TextsRevealDirection } {
  const [displayedIndex, setDisplayedIndex] = useState(index);
  const [phase, setPhase] = useState<TextsRevealPhase>(() => (revealed ? "shown" : "hidden"));
  const [direction, setDirection] = useState<TextsRevealDirection>("down");
  // Read (not depended on) by the exit effect below so its own
  // setPhase("hiding") doesn't retrigger it — with `phase` itself as a
  // dependency there, that self-retrigger's cleanup would cancel the
  // hideTimer it had just set, before the early-return guard skips
  // scheduling a replacement, leaving phase stuck at "hiding" forever (and
  // the entrance effect's "hidden" guard never satisfied again). The
  // entrance effect below has no such timer/cleanup to cancel, so it stays
  // safely keyed off `phase` directly — needed so it can also fire when
  // `phase` settles to "hidden" *after* `revealed` already flipped back to
  // true (rapid scroll-down-up-down near the boundary), not only at the
  // instant `revealed` itself changes.
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  useEffect(() => {
    if (phase !== "hidden" || !revealed) return;
    setDirection("down");
    setPhase("enterStart");
  }, [phase, revealed]);

  useEffect(() => {
    if (revealed || phaseRef.current === "hidden" || phaseRef.current === "hiding") return;
    setDirection("up");
    setPhase("hiding");
    let settledNaturally = false;
    const hideTimer = window.setTimeout(() => {
      settledNaturally = true;
      setPhase("hidden");
    }, hideMs);
    // If `revealed` flips true again before this fires (rapid scroll back
    // down mid-exit), cleanup cancels the timer — but phase is still
    // "hiding" at that point, and nothing else would ever move it off that
    // (the entrance effect above only fires from "hidden"). Snap straight
    // back to "shown" here instead of leaving it stuck.
    return () => {
      window.clearTimeout(hideTimer);
      if (!settledNaturally) setPhase("shown");
    };
  }, [revealed, hideMs]);

  useEffect(() => {
    if (index === displayedIndex) return;
    setDirection(index > displayedIndex ? "down" : "up");
    setPhase("hiding");
    const hideTimer = window.setTimeout(() => {
      setDisplayedIndex(index);
      setPhase("enterStart");
    }, hideMs);
    return () => window.clearTimeout(hideTimer);
  }, [index, displayedIndex, hideMs]);

  useEffect(() => {
    if (phase !== "enterStart") return;
    const id = requestAnimationFrame(() => setPhase("shown"));
    return () => cancelAnimationFrame(id);
  }, [phase]);

  return { displayedIndex, phase, direction };
}

interface IconAnimationHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

// The lucide-animated icon components only self-trigger on hover over their
// own (icon-sized) bounding box. Buttons want the whole hit area to trigger
// the icon on press (not hover), so the icon is used in "controlled" mode via
// ref and driven from the button's own pointer down/up/leave instead.
function useIconPressHandlers<T extends IconAnimationHandle>() {
  const ref = useRef<T>(null);
  return {
    ref,
    onPointerDown: () => ref.current?.startAnimation(),
    onPointerLeave: () => ref.current?.stopAnimation(),
    onPointerUp: () => ref.current?.stopAnimation(),
  };
}

export function Panel() {
  // The /scroll route always starts with the control panel hidden — same
  // "ignore the shared preference on load, not just fall back to it"
  // treatment as IS_SCROLL_ROUTE's shaderTheme default in main.js, and for
  // the same reason: CONTROLS_HIDDEN_KEY is shared storage across every
  // route, so a "visible" preference saved elsewhere would otherwise leak in
  // here too. The H key can still show it for the current session (see the
  // persist effect below, which skips writing through to storage on this
  // route so that toggle never leaks back out to other routes either).
  const [hidden, setHidden] = useState(() =>
    controls.getInitialState().isScrollRoute || controls.getInitialState().isPreviewRoute
      ? true
      : localStorage.getItem(CONTROLS_HIDDEN_KEY) === "1",
  );
  const [state, setState] = useState(() => controls.getInitialState());
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  // Instructions guide (root route only, see isPlainRoute in main.js): open
  // on every load, reopened with the I key.
  const [guideOpen, setGuideOpen] = useState(() => !!controls.getInitialState().isPlainRoute);
  const closeGuide = useCallback(() => setGuideOpen(false), []);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadModelIconPress = useIconPressHandlers<UploadIconHandle>();
  const resetPositionIconPress = useIconPressHandlers<UndoDotIconHandle>();
  const goIconRefs = useRef<(ArrowBigRightDashIconHandle | null)[]>([]);
  const resetViewIconPress = useIconPressHandlers<UndoDotIconHandle>();
  const setDefaultViewIconPress = useIconPressHandlers<MapPinIconHandle>();
  const goDefaultViewIconRef = useRef<ArrowBigRightDashIconHandle | null>(null);
  const resetRotationIconPress = useIconPressHandlers<UndoDotIconHandle>();
  const resetSizeIconPress = useIconPressHandlers<UndoDotIconHandle>();
  const spaceIndicator = useTextSwap(!!state.spaceHeld, TEXT_SWAP_MS);
  const photoIndicator = useTextSwap(!!state.photoMode, TEXT_SWAP_MS);

  useEffect(() => controls.subscribe((patch: object) => setState((s) => ({ ...s, ...patch }))), []);

  useEffect(() => {
    // Never persists on the /scroll route — see the forced-hidden default
    // above for why.
    // Nor on a preview route (battery-preview.html), hidden for good there.
    if (state.isScrollRoute || state.isPreviewRoute) return;
    localStorage.setItem(CONTROLS_HIDDEN_KEY, hidden ? "1" : "0");
  }, [hidden, state.isScrollRoute, state.isPreviewRoute]);

  useEffect(() => {
    controls.setPanelsHidden(hidden);
  }, [hidden]);

  useEffect(() => {
    // scroll-preview.html's whole point is a panel-free view with no escape
    // hatch — state.isPreviewRoute (fixed across the page's lifetime, same
    // as isScrollRoute) skips wiring the H listener up at all there, rather
    // than wiring it up and then no-op'ing inside it, so there's nothing to
    // strip out for a future tree-shaken build either (see main.js's own
    // IS_PREVIEW_ROUTE comment).
    if (state.isPreviewRoute) return;
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "h") return;
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return; // don't hijack typing into a slider/text field
      setHidden((h) => !h);
    };
    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
  }, [state.isPreviewRoute]);

  useEffect(() => {
    if (!state.isPlainRoute) return;
    const onKeydown = (event: KeyboardEvent) => {
      if (event.code !== "KeyI" || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      event.preventDefault();
      setGuideOpen(true);
    };
    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
  }, [state.isPlainRoute]);

  useEffect(() => {
    // dragenter/dragleave fire repeatedly as the cursor crosses child element
    // boundaries, so a counter (rather than a single boolean) is needed to
    // know when the drag has actually left the window. main.js has its own
    // window-level drop handler that does the actual model loading; this
    // effect only tracks drag state to show the overlay.
    // Not on /battery-preview: embedded in a host page, file drags there are
    // none of this module's business (main.js skips its drop handler too).
    if (controls.getInitialState().isPreviewRoute && controls.getInitialState().isBatteryRoute) return;
    let depth = 0;
    const isFileDrag = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");

    const onDragEnter = (event: DragEvent) => {
      if (!isFileDrag(event)) return;
      depth += 1;
      setIsDraggingFile(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (isFileDrag(event)) event.preventDefault();
    };
    const onDragLeave = (event: DragEvent) => {
      if (!isFileDrag(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setIsDraggingFile(false);
    };
    const onDrop = () => {
      depth = 0;
      setIsDraggingFile(false);
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  const overlayPhase = useRevealPhase(isDraggingFile, MODAL_CLOSE_MS);
  const guidePhase = useRevealPhase(guideOpen, MODAL_CLOSE_MS);
  const panelPhase = useRevealPhase(!hidden, MODAL_CLOSE_MS);
  // /battery has no camera targets, so the section never opens there.
  const cameraTargetsPhase = useRevealPhase(!state.isBatteryRoute && !state.isPlainRoute && (state.customModelObjectNames?.length ?? 0) > 0, MODAL_CLOSE_MS);
  const photoOptionsPhase = useRevealPhase(!!state.photoMode, MODAL_CLOSE_MS);
  const lineWidthSliderPhase = useRevealPhase(!!state.photoUniformLineWidth, MODAL_CLOSE_MS);
  // Photo card's "Customise" disclosure (uniform line width lives behind
  // it) — collapsed by default every time photo mode opens.
  const [photoCustomizeOpen, setPhotoCustomizeOpen] = useState(false);
  useEffect(() => {
    if (!state.photoMode) setPhotoCustomizeOpen(false);
  }, [state.photoMode]);
  const photoCustomizePhase = useRevealPhase(photoCustomizeOpen, MODAL_CLOSE_MS);
  // Shader Controls' "Customise patterns" disclosure (line/dot/plus sliders)
  // — collapsed by default.
  const [patternsOpen, setPatternsOpen] = useState(false);
  const patternsPhase = useRevealPhase(patternsOpen, MODAL_CLOSE_MS);
  // Quick-reset pills beside the Space pill: shown only while the model is
  // off its default position (X/Y/height) or zoom (Model size 100%), and
  // hidden with the rest of the UI when H is pressed.
  const modelPositionMoved =
    Math.round(state.modelOffsetX ?? 0) !== 0 ||
    Math.round(state.modelOffsetY ?? 0) !== 0 ||
    Math.round(state.modelOffsetZ ?? 0) !== 0;
  const modelZoomChanged = Math.round(state.cubeSize ?? 100) !== 100;
  const resetPositionPillPhase = useRevealPhase(!hidden && modelPositionMoved, MODAL_CLOSE_MS);
  const resetZoomPillPhase = useRevealPhase(!hidden && modelZoomChanged, MODAL_CLOSE_MS);
  // The export size follows the window's aspect ratio, so re-render on resize
  // while photo mode is open; the value itself comes from main.js.
  const [, setPhotoExportViewport] = useState(() => `${window.innerWidth}x${window.innerHeight}`);
  useEffect(() => {
    if (!state.photoMode) return;
    const onResize = () => setPhotoExportViewport(`${window.innerWidth}x${window.innerHeight}`);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [state.photoMode]);
  const photoExportSize = controls.getPhotoExportSize(!!state.photoExport2x);
  // Completion feedback: main.js bumps photoCaptureCount once a capture's
  // PNG has actually been handed to the browser (button click or Enter), and
  // the Capture button reads "Saved" for a beat.
  const [captureSaved, setCaptureSaved] = useState(false);
  const lastCaptureCountRef = useRef(state.photoCaptureCount ?? 0);
  useEffect(() => {
    const count = state.photoCaptureCount ?? 0;
    if (count === lastCaptureCountRef.current) return;
    lastCaptureCountRef.current = count;
    setCaptureSaved(true);
    const timer = window.setTimeout(() => setCaptureSaved(false), 1400);
    return () => window.clearTimeout(timer);
  }, [state.photoCaptureCount]);
  const sortedCustomModelObjectNames = [...(state.customModelObjectNames ?? [])].sort((a, b) =>
    a.localeCompare(b),
  );
  // main.js's cubeModelStatus is one string — "name.obj (12,345 tris, colors
  // from name.mtl)" on success, "Couldn't …" on failure. Split it so the
  // file name and its details render as a title + muted meta line.
  const modelStatus = useMemo(() => {
    const status: string = state.cubeModelStatus ?? "";
    if (!status) return null;
    if (status.startsWith("Couldn't")) return { name: status, meta: "", isError: true };
    const match = status.match(/^(.*) \((.*)\)$/);
    return match
      ? { name: match[1], meta: match[2].split(", ").join(" · "), isError: false }
      : { name: status, meta: "", isError: false };
  }, [state.cubeModelStatus]);
  // The card's step count should match however many Camera Target slots are
  // actually assigned, not the raw 7-slot capacity — cameraTargetActiveIndex
  // is a raw slot index (e.g. 5, if slots 0/2/5 are the only ones assigned),
  // but the card should read "Step 3" there (the 3rd assigned target), not
  // "Step 6". assignedSlotIndices is cameraTargetSlots (main.js's
  // CAMERA_TARGET_SLOT_COUNT-length array of names/nulls) compacted down to
  // just the assigned ones, in slot order; activeTargetPosition is where the
  // active slot falls in that compacted list — the actual CARD_STEPS index.
  // -1 (nothing assigned yet, or somehow not found) falls back to 0.
  const assignedSlotIndices = (state.cameraTargetSlots ?? []).reduce<number[]>((acc, name, i) => {
    if (name) acc.push(i);
    return acc;
  }, []);
  const activeTargetPosition = Math.max(0, assignedSlotIndices.indexOf(state.cameraTargetActiveIndex ?? -1));
  // Tracks whether scroll is past the very top of the intro span (see the
  // card's own physical-entrance effect below, which flips this the moment
  // scroll crosses off/back to exactly 0) so the card's content plays the
  // same staggered blurred-rise entrance a later step change does — and,
  // reversibly, the same motion backward if the user scrolls back up past
  // it — starting alongside the card's own scroll-driven fade/rise rather
  // than only after it finishes.
  const [cardContentRevealed, setCardContentRevealed] = useState(false);
  const cardContentReveal = useTextsReveal(activeTargetPosition, TEXTS_REVEAL_HIDE_MS, cardContentRevealed);
  const cardContent = CARD_STEPS[cardContentReveal.displayedIndex] ?? CARD_STEPS[0];

  // Card's own physical entrance: starts 32px below its resting position,
  // fully transparent and slightly blurred, then rises/fades/sharpens into
  // place across the scroll track's leading "intro" span — during which
  // main.js's own renderCubeFrame (IS_SCROLL_ROUTE branch) deliberately
  // holds the camera still on Target 1 instead of blending anywhere, see
  // its introFraction and updateScrollTrackHeight's matching "+ 1" span.
  // numTargetsRef tracks assignedSlotIndices.length across renders without
  // re-subscribing the scroll listener below (kept in a ref, not read
  // directly in the effect, since the effect intentionally mounts once for
  // the route's lifetime). Driven by direct ref.style writes rather than
  // React state so this reads as continuously scroll-scrubbed, not a
  // discrete step transition — same reasoning as main.js's own
  // SCROLL_SCRUB_SMOOTHING/goal math never touching React either, just for
  // the DOM instead of WebGL.
  const CARD_INTRO_OFFSET_PX = 64;
  const CARD_INTRO_BLUR_PX = 4;
  // Kept in sync with main.js's own SCROLL_INTRO_SPAN_VH_UNITS — both need
  // to agree on how much of the track is intro vs. target-to-target scroll.
  const SCROLL_INTRO_SPAN_VH_UNITS = 0.5;
  const introCardRef = useRef<HTMLDivElement>(null);
  const numTargetsRef = useRef(assignedSlotIndices.length);
  numTargetsRef.current = assignedSlotIndices.length;
  useLayoutEffect(() => {
    if (!state.isScrollRoute) return;
    const card = introCardRef.current;
    if (!card) return;
    let raf = 0;
    // Toggles the content stagger-entrance/exit (see cardContentRevealed
    // above) the moment scroll crosses off/back to exactly 0 — entering
    // alongside the card's own physical reveal instead of only after that
    // finishes, so the two read as one concurrent motion, and reversing
    // (playing the same motion backward, see useTextsReveal's own second
    // effect) if the user scrolls back up past the intro span, same as the
    // card's own physical entrance already does. Tracked in a local var
    // rather than read back off React state so this only ever calls
    // setState on an actual flip — every other scroll tick (this effect
    // keeps handling scroll for the rest of the page) just keeps
    // re-writing the settled style directly, cheaply, without routing back
    // through React.
    let contentRevealedLocal = false;
    const update = () => {
      raf = 0;
      const introFraction =
        SCROLL_INTRO_SPAN_VH_UNITS / (Math.max(1, numTargetsRef.current) + SCROLL_INTRO_SPAN_VH_UNITS);
      // Section-relative, via #scroll-track's own document position, rather
      // than the whole document's scrollHeight — kept in sync with main.js's
      // own copy of this same formula (see its IS_SCROLL_ROUTE branch) so
      // the card's entrance and the camera's intro-span move land together
      // whether #scroll-track spans the entire page (scroll.html/scroll-
      // preview.html) or is embedded as one section of a longer page
      // (scroll-embed.html) with unrelated content before/after it.
      const scrollTrackEl = document.getElementById("scroll-track");
      const sectionScrollTop = scrollTrackEl
        ? scrollTrackEl.getBoundingClientRect().top + window.scrollY
        : 0;
      const maxScroll = (scrollTrackEl?.offsetHeight ?? document.documentElement.scrollHeight) - window.innerHeight;
      const progress = maxScroll > 0 ? Math.max(0, Math.min(1, (window.scrollY - sectionScrollTop) / maxScroll)) : 0;
      const introProgress = Math.max(0, Math.min(1, progress / introFraction));
      const eased = 1 - (1 - introProgress) ** 3; // ease-out cubic
      card.style.transform = `translateY(${(1 - eased) * CARD_INTRO_OFFSET_PX}px)`;
      card.style.opacity = String(eased);
      card.style.filter = `blur(${(1 - eased) * CARD_INTRO_BLUR_PX}px)`;
      const shouldBeRevealed = introProgress > 0;
      if (shouldBeRevealed !== contentRevealedLocal) {
        contentRevealedLocal = shouldBeRevealed;
        setCardContentRevealed(shouldBeRevealed);
      }
    };
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [state.isScrollRoute]);

  // Animates the card's own height across a step change — its content wraps
  // to a different number of lines depending on the step's copy length, so
  // a step change can make the card noticeably taller or shorter at *any*
  // width, not just below sm: at sm and up the icon tile only sets a
  // *floor* (200px + the row's own gap/padding), and long copy (e.g. Step
  // 2's three-sentence body) still pushes the row taller than that floor,
  // so desktop needs this animation too. cardRowRef sits on the flex row
  // that holds both the icon tile and the text stack (see the card's own
  // JSX) — not just the text — specifically so the icon's fixed height is
  // part of what gets measured; measuring the text stack alone would report
  // a too-small height on desktop whenever the icon is the taller sibling.
  // It's left unconstrained (no explicit height of its own) so it always
  // reports its true natural height; the padding added back on top varies
  // by breakpoint (checked live off window.innerWidth in the observer
  // callback below, not cached, since a resize across the sm boundary can
  // itself be what triggers the row's next measurement) since the outer
  // card is what actually gets the animated height and its own padding
  // shrinks from p-6 to sm:p-3. null (measured only after mount) falls back
  // to the outer card's own natural/auto height in the style prop below, so
  // there's no jump on first paint before ResizeObserver's first callback
  // fires.
  //
  // A flat duration made grow and shrink feel different even at the same
  // number of ms, since they're rarely the same number of pixels — so
  // duration here is derived from the height delta at a fixed speed
  // (CARD_HEIGHT_PX_PER_MS) instead, clamped to [CARD_HEIGHT_MIN_MS,
  // CARD_HEIGHT_MAX_MS] so a 1px delta doesn't play instantly and a huge
  // one doesn't crawl. Same formula both directions, so grow and shrink
  // genuinely move at the same rate rather than each getting its own
  // hand-picked constant. prevCardHeightRef holds the last *measured*
  // height (not React state, which only commits after this render) purely
  // so the very next ResizeObserver callback can compare against it
  // synchronously.
  const CARD_VERTICAL_PADDING_MOBILE_PX = 48; // keep in sync with the outer card's p-6 below sm
  const CARD_VERTICAL_PADDING_DESKTOP_PX = 24; // keep in sync with the outer card's sm:p-3
  const CARD_HEIGHT_PX_PER_MS = 0.6; // ~360px in 600ms, the old flat duration's rough default case
  const CARD_HEIGHT_MIN_MS = 150;
  const CARD_HEIGHT_MAX_MS = 500;
  const cardRowRef = useRef<HTMLDivElement>(null);
  const [cardHeight, setCardHeight] = useState<number | null>(null);
  const [cardHeightDurationMs, setCardHeightDurationMs] = useState(CARD_HEIGHT_MAX_MS);
  const prevCardHeightRef = useRef<number | null>(null);
  useEffect(() => {
    if (!state.isScrollRoute) return;
    const row = cardRowRef.current;
    if (!row) return;
    const observer = new ResizeObserver(([entry]) => {
      const padding = window.innerWidth < 640 ? CARD_VERTICAL_PADDING_MOBILE_PX : CARD_VERTICAL_PADDING_DESKTOP_PX;
      const nextHeight = Math.round(entry.contentRect.height) + padding;
      const prevHeight = prevCardHeightRef.current;
      if (prevHeight !== null && nextHeight !== prevHeight) {
        const delta = Math.abs(nextHeight - prevHeight);
        const duration = Math.min(CARD_HEIGHT_MAX_MS, Math.max(CARD_HEIGHT_MIN_MS, delta / CARD_HEIGHT_PX_PER_MS));
        setCardHeightDurationMs(duration);
      }
      prevCardHeightRef.current = nextHeight;
      setCardHeight(nextHeight);
    });
    observer.observe(row);
    return () => observer.disconnect();
  }, [state.isScrollRoute]);

  // The battery count slider in the Model Controls panel (/battery-preview
  // has its own horizontal one, see below).
  const batteryCountControl = (
    <div className="flex items-start gap-6">
      <Field className="relative h-48 w-4 shrink-0">
        <FieldLabel className="sr-only">Battery count</FieldLabel>
        <Slider
          className="h-full"
          max={state.batteryCountMax}
          min={state.batteryCountMin}
          onValueChange={(value: number | readonly number[]) => controls.setBatteryStackCount(Array.isArray(value) ? value[0] : value as number)}
          orientation="vertical"
          step={1}
          value={state.batteryStackCount}
        />
      </Field>
      <div className="flex h-48 flex-1 flex-col justify-between text-muted-foreground text-xs">
        {Array.from({ length: state.batteryCountMax - state.batteryCountMin + 1 }, (_, i) => state.batteryCountMax - i).map(count => (
          <button
            aria-label={`Select ${count} batteries`}
            aria-pressed={state.batteryStackCount === count}
            className={cn("text-left tabular-nums", state.batteryStackCount === count && "text-foreground")}
            key={count}
            onClick={() => controls.setBatteryStackCount(count)}
            type="button"
          >
            {count}{state.batteryStackCount === count ? " batteries" : ""}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <>
      {state.isPlainRoute && <InstructionsModal onClose={closeGuide} phase={guidePhase} />}

      {overlayPhase !== "closed" && (
        <div
          className={cn(
            "t-overlay-backdrop pointer-events-none fixed inset-0 z-20 flex items-center justify-center bg-info/30 backdrop-blur-[1px]",
            overlayPhase === "open" && "is-open",
            overlayPhase === "closing" && "is-closing",
          )}
        >
          <p
            className={cn(
              "t-modal rounded-full border border-white/30 bg-black/50 px-6 py-3 font-semibold text-lg text-white",
              overlayPhase === "open" && "is-open",
              overlayPhase === "closing" && "is-closing",
            )}
          >
            Drop the file to change the model
          </p>
        </div>
      )}

      {/* /battery-preview's only control (the panels never show there): the
          same battery count slider as the Model Controls panel's, laid out
          horizontally along the bottom. Absolute, not fixed: it belongs to
          the section this module is embedded in (see battery-preview.html's
          #battery-stage) and scrolls away with it. */}
      {state.isPreviewRoute && state.isBatteryRoute && state.batteryStackEnabled && (
        <div className="absolute bottom-6 left-1/2 z-10 flex w-[min(92vw,22rem)] -translate-x-1/2 flex-col gap-3 rounded-[24px] border border-border bg-popover/80 px-6 py-5 text-popover-foreground text-sm shadow-lg backdrop-blur-sm">
          {state.isSidewaysBattery && (
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground text-xs" aria-live="polite">{state.batteryStackCount} {state.batteryStackCount === 1 ? "battery" : "batteries"}</span>
              <div className="flex gap-1" role="group" aria-label="Battery model">
                {["EP5", "EP12"].map(model => (
                  <Button
                    key={model}
                    size="sm"
                    variant={state.batteryModel === model ? "secondary" : "ghost"}
                    aria-pressed={state.batteryModel === model}
                    disabled={state.batteryModelLoading}
                    onClick={() => controls.setBatteryModel(model)}
                  >
                    {model}
                  </Button>
                ))}
              </div>
            </div>
          )}
          <Field>
            <FieldLabel className="sr-only">Battery count</FieldLabel>
            <Slider
              disabled={state.batteryModelLoading}
              max={state.batteryCountMax}
              min={state.batteryCountMin}
              onValueChange={(value: number | readonly number[]) => controls.setBatteryStackCount(Array.isArray(value) ? value[0] : value as number)}
              step={1}
              value={state.batteryStackCount}
            />
          </Field>
          <div className="flex justify-between text-muted-foreground text-xs">
            {Array.from({ length: state.batteryCountMax - state.batteryCountMin + 1 }, (_, i) => state.batteryCountMin + i).map(count => (
              <button
                aria-label={`Select ${count} ${count === 1 ? "battery" : "batteries"}`}
                disabled={state.batteryModelLoading}
                aria-pressed={state.batteryStackCount === count}
                className={cn("w-4 text-center tabular-nums", state.batteryStackCount === count && "text-foreground")}
                key={count}
                onClick={() => controls.setBatteryStackCount(count)}
                type="button"
              >
                {count}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* H no longer does anything on the preview route (see its own
          skipped-listener effect above), so this hint would be actively
          misleading there — hidden rather than left dangling. */}
      {!state.isPreviewRoute && (
        <div
          className={cn(
            "t-chrome t-chrome-bottom-right pointer-events-none fixed right-4 bottom-4 z-10 flex items-center gap-1.5 text-muted-foreground text-xs",
            hidden && "is-panels-hidden",
          )}
        >
          {state.isPlainRoute && (
            <>
              <Kbd className="h-auto min-w-0 w-auto p-1 text-[10px] leading-none">I</Kbd>
              instructions
              <span aria-hidden="true" className="px-1">·</span>
            </>
          )}
          <Kbd className="h-auto min-w-0 w-auto p-1 text-[10px] leading-none">H</Kbd>
          hides the panels
        </div>
      )}

      {panelPhase !== "closed" && (
        <div className="pointer-events-none fixed top-1/2 left-1/2 z-10 -translate-x-1/2 -translate-y-1/2">
          <svg
            className={cn(
              "t-fade-center size-5 text-white/25",
              panelPhase === "open" && "is-open",
              panelPhase === "closing" && "is-closing",
            )}
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeWidth="1.5"
            viewBox="0 0 24 24"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
          </svg>
        </div>
      )}

      {panelPhase !== "closed" && (
        <div className="pointer-events-none fixed bottom-6 left-1/2 z-10 flex -translate-x-1/2 flex-col items-center gap-2">
          {!state.isScrollRoute && !state.isBatteryRoute && (
          <div>
            {/* Clicking the pill does what P does: toggles photo mode (same
                as the P handler in main.js). */}
            <button
              className={cn(
                "t-fade-center overflow-hidden rounded-full border px-3 py-1.5 font-medium text-xs shadow-lg backdrop-blur-sm transition-colors duration-[var(--text-swap-dur)]",
                "pointer-events-auto cursor-pointer",
                photoIndicator.displayed
                  ? "border-transparent bg-white text-black"
                  : "border-input bg-popover/80 text-foreground",
                panelPhase === "open" && "is-open",
                panelPhase === "closing" && "is-closing",
              )}
              onClick={(event) => {
                // Drop focus so Enter goes to the photo-mode capture
                // shortcut, not back to this focused button.
                event.currentTarget.blur();
                controls.setPhotoMode(!state.photoMode);
              }}
              type="button"
            >
              <span
                className={cn(
                  "t-text-swap",
                  photoIndicator.phase === "exit" && (state.photoMode ? "is-exit-up" : "is-exit-down"),
                  photoIndicator.phase === "enterStart" &&
                    (state.photoMode ? "is-enter-from-bottom" : "is-enter-from-top"),
                )}
              >
                {photoIndicator.displayed ? (
                  <>
                    Press <Kbd className="h-auto min-w-0 w-auto p-1 text-[10px] leading-none">P</Kbd> or{" "}
                    <Kbd className="h-auto min-w-0 w-auto p-1 text-[10px] leading-none">Esc</Kbd> to exit photo mode
                  </>
                ) : (
                  <>
                    Press <Kbd className="h-auto min-w-0 w-auto p-1 text-[10px] leading-none">P</Kbd> for photo mode
                  </>
                )}
              </span>
            </button>

            {photoOptionsPhase !== "closed" && (
              <div className="pointer-events-none absolute bottom-0 left-full ml-3">
                {/* Positioned against the whole fixed pill stack (its parent
                    div deliberately isn't `relative`), so the card's bottom
                    sits on the stack's bottom-6 line — same 24px viewport
                    gap as the last pill — and it clears the widest pill on
                    the right. Bottom-anchored, so "Customise" grows it
                    upward only. */}
                <div
                  className={cn(
                    "t-fade-center panel-material pointer-events-auto flex w-72 flex-col gap-3 rounded-[28px] border border-border p-4 text-xs",
                    photoOptionsPhase === "open" && "is-open",
                    photoOptionsPhase === "closing" && "is-closing",
                  )}
                  // Grows out of the pill it's attached to (its bottom-left
                  // corner, matching the bottom anchor above), not from its own
                  // center — set inline since .t-fade-center pins
                  // transform-origin to center.
                  style={{ transformOrigin: "left bottom" }}
                >
                  {/* Header: title + close in one row, so the X sits in a
                      predictable spot instead of floating over content. */}
                  <div className="flex items-center justify-between gap-2 pl-1">
                    <span className="flex items-center gap-2 font-semibold text-foreground text-sm tracking-[-0.011em]">
                      <Camera className="size-4 text-muted-foreground" />
                      Photo
                    </span>
                    <Button
                      aria-label="Exit photo mode"
                      className="-mr-1 rounded-full text-muted-foreground hover:text-foreground"
                      onClick={() => controls.setPhotoMode(false)}
                      size="icon-xs"
                      variant="ghost"
                    >
                      <X className="size-3.5" />
                    </Button>
                  </div>
                  {/* Settings grouped on one inset surface; radius nests
                      inside the card's (28 - 16px padding = 12). */}
                  <div className="flex flex-col gap-3 rounded-xl bg-white/4 px-3 py-3">
                  <div className="flex items-center justify-between gap-2">
                  <Label className="gap-2.5 text-xs">
                    <Switch
                      checked={!!state.photoExport2x}
                      onCheckedChange={(checked: boolean) => {
                        controls.setPhotoExport2x(checked);
                        setState((s) => ({ ...s, photoExport2x: checked }));
                      }}
                    />
                    @2x resolution
                  </Label>
                  {/* Exported pixel size for the current toggle + window
                      aspect (resize re-renders, see setPhotoExportViewport). */}
                  <span
                    aria-live="polite"
                    className="text-[11px] text-muted-foreground tabular-nums"
                  >
                    {photoExportSize.width} × {photoExportSize.height}
                  </span>
                  </div>
                  {/* Uniform line width (and its slider) tucked behind a small
                      disclosure link — an advanced option, one level deeper
                      than the common path (@2x + Capture). */}
                  <button
                    aria-expanded={photoCustomizeOpen}
                    className="flex w-fit cursor-pointer items-center gap-1 rounded-sm text-muted-foreground text-xs outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => setPhotoCustomizeOpen((open) => !open)}
                    type="button"
                  >
                    Customise
                    <ChevronDown
                      className={cn(
                        "size-3.5 transition-transform duration-200 ease-out motion-reduce:transition-none",
                        photoCustomizeOpen && "rotate-180",
                      )}
                    />
                  </button>
                  {photoCustomizePhase !== "closed" && (
                  <div
                    className={cn(
                      "t-reveal",
                      photoCustomizePhase === "open" && "is-open",
                      photoCustomizePhase === "closing" && "is-closing",
                    )}
                  >
                  <div className="flex flex-col gap-3 p-0.5">
                  <Label className="gap-2.5 text-xs">
                    <Switch
                      checked={!!state.photoUniformLineWidth}
                      onCheckedChange={(checked: boolean) => {
                        controls.setPhotoUniformLineWidth(checked);
                        setState((s) => ({ ...s, photoUniformLineWidth: checked }));
                      }}
                    />
                    Uniform line width
                    <span className="rounded-full bg-info/15 px-1.5 py-0.5 font-semibold text-[10px] text-info leading-none">
                      New
                    </span>
                  </Label>
                  {lineWidthSliderPhase !== "closed" && (
                    <div
                      className={cn(
                        "t-reveal",
                        lineWidthSliderPhase === "open" && "is-open",
                        lineWidthSliderPhase === "closing" && "is-closing",
                      )}
                    >
                      <Field className="pt-1 pb-2">
                        <Slider
                          max={state.photoLineWidthHalfPxMax}
                          min={state.photoLineWidthHalfPxMin}
                          onValueChange={(value: number | readonly number[]) => {
                            const halfWidthPx = value as number;
                            controls.setPhotoLineWidthHalfPx(halfWidthPx);
                            setState((s) => ({ ...s, photoLineWidthHalfPx: halfWidthPx }));
                          }}
                          step={0.1}
                          value={state.photoLineWidthHalfPx}
                        >
                          <div className="mb-3 flex w-full items-center justify-between gap-1">
                            <FieldLabel className="text-xs sm:text-xs">Line width</FieldLabel>
                            <SliderValue className="text-xs text-muted-foreground" />
                          </div>
                        </Slider>
                        <p className="mt-1 flex gap-1.5 text-[11px] text-muted-foreground leading-snug">
                          <TriangleAlert aria-hidden="true" className="mt-px size-3 shrink-0 text-warning" />
                          Changing the line width can produce results that aren't consistent with the brand. Use with
                          caution.
                        </p>
                      </Field>
                    </div>
                  )}
                  </div>
                  </div>
                  )}
                  </div>
                  <Button
                    className="h-10 w-full rounded-xl text-sm sm:h-10 sm:text-sm"
                    onClick={() => controls.capturePhoto()}
                    size="lg"
                  >
                    {captureSaved ? (
                      <>
                        <Check className="size-4" />
                        Saved
                      </>
                    ) : (
                      <>
                        <Camera className="size-4" />
                        Capture
                        <Kbd className="ml-auto h-auto min-w-0 w-auto bg-black/8 p-1 text-[10px] text-primary-foreground/70 leading-none">
                          Enter
                        </Kbd>
                      </>
                    )}
                  </Button>
                </div>
              </div>
            )}
          </div>
          )}

          {/* Space pill + quick resets. The reset pills appear only once the
              model is off its default position / zoom, and sit to the LEFT
              of the Space pill (absolutely, so it stays centered and they
              never collide with the photo card on the right). Each blurs
              itself after a click so Space/P/Enter keep reaching main.js. */}
          <div className="relative">
            <div
              className={cn(
                "t-fade-center overflow-hidden rounded-full border px-3 py-1.5 font-medium text-xs shadow-lg backdrop-blur-sm transition-colors duration-[var(--text-swap-dur)]",
                spaceIndicator.displayed
                  ? "border-transparent bg-white text-black"
                  : "border-input bg-popover/80 text-foreground",
                panelPhase === "open" && "is-open",
                panelPhase === "closing" && "is-closing",
              )}
            >
              <span
                className={cn(
                  "t-text-swap",
                  spaceIndicator.phase === "exit" && (state.spaceHeld ? "is-exit-up" : "is-exit-down"),
                  spaceIndicator.phase === "enterStart" &&
                    (state.spaceHeld ? "is-enter-from-bottom" : "is-enter-from-top"),
                )}
              >
                {spaceIndicator.displayed ? (
                  "Release to confirm the new position"
                ) : (
                  <>
                    Hold <Kbd className="h-auto min-w-0 w-auto p-1 text-[10px] leading-none">Space</Kbd> to move the model
                  </>
                )}
              </span>
            </div>
            <div className="pointer-events-none absolute top-1/2 right-full mr-2 flex -translate-y-1/2 items-center gap-2">
              {resetZoomPillPhase !== "closed" && (
                <button
                  className={cn(
                    "t-fade-center pointer-events-auto flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border border-transparent bg-white px-3 py-1.5 font-medium text-black text-xs shadow-lg backdrop-blur-sm transition-[background-color,scale] duration-100 ease-out hover:bg-white/90 active:scale-[0.97]",
                    resetZoomPillPhase === "open" && "is-open",
                    resetZoomPillPhase === "closing" && "is-closing",
                  )}
                  onClick={(event) => {
                    event.currentTarget.blur();
                    const clamped = controls.setCubeSizePercent(100);
                    setState((s) => ({ ...s, cubeSize: clamped }));
                  }}
                  type="button"
                >
                  <UndoDotIcon className="size-3" />
                  Reset zoom
                </button>
              )}
              {resetPositionPillPhase !== "closed" && (
                <button
                  className={cn(
                    "t-fade-center pointer-events-auto flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border border-transparent bg-white px-3 py-1.5 font-medium text-black text-xs shadow-lg backdrop-blur-sm transition-[background-color,scale] duration-100 ease-out hover:bg-white/90 active:scale-[0.97]",
                    resetPositionPillPhase === "open" && "is-open",
                    resetPositionPillPhase === "closing" && "is-closing",
                  )}
                  onClick={(event) => {
                    event.currentTarget.blur();
                    controls.resetModelPosition();
                    setState((s) => ({ ...s, modelOffsetX: 0, modelOffsetY: 0, modelOffsetZ: 0 }));
                  }}
                  type="button"
                >
                  <UndoDotIcon className="size-3" />
                  Reset position
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {panelPhase !== "closed" && (
        <div
          className={cn(
            "t-panel t-panel-left fixed top-4 left-4 z-10 max-h-[calc(100vh-2rem)] w-[min(92vw,17rem)] overflow-hidden panel-material rounded-[24px] border border-border text-popover-foreground text-sm",
            panelPhase === "open" && "is-open",
            panelPhase === "closing" && "is-closing",
          )}
        >
          <div className="panel-scrollbar panel-scroll-edges flex h-full max-h-[calc(100vh-2rem)] flex-col gap-6 overflow-y-auto p-6">
            <h2 className="font-semibold text-base text-foreground tracking-[-0.011em]">Model Controls</h2>

            <div className="flex flex-col gap-3">
              <input
                ref={fileInputRef}
                accept=".obj,.mtl"
                className="hidden"
                multiple
                onChange={(event) => {
                  controls.loadModelFiles(Array.from(event.target.files ?? []));
                  event.target.value = "";
                }}
                type="file"
              />
              {/* One full-width drop-zone tile: the action and its drag-and-drop
                  alternative read as one control (title + hint), instead of a
                  small button with loose text wrapping beside it. */}
              <button
                className="group flex w-full cursor-pointer items-center gap-3 rounded-xl border border-input border-dashed bg-input/40 px-3 py-2.5 text-left outline-none transition-[background-color,border-color,scale] duration-100 ease-out hover:border-ring/40 hover:bg-input/70 focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.98]"
                onClick={() => fileInputRef.current?.click()}
                onPointerDown={loadModelIconPress.onPointerDown}
                onPointerLeave={loadModelIconPress.onPointerLeave}
                onPointerUp={loadModelIconPress.onPointerUp}
                type="button"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary">
                  <UploadIcon className="size-4" ref={loadModelIconPress.ref} />
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-medium text-foreground text-xs">Load model…</span>
                  <span className="text-[11px] text-muted-foreground leading-tight">or drop .obj + .mtl anywhere</span>
                </span>
              </button>
              {modelStatus && (
                <div className="flex min-w-0 flex-col gap-0.5 px-1" title={state.cubeModelStatus}>
                  <span
                    className={cn(
                      "truncate font-medium text-xs",
                      modelStatus.isError ? "text-destructive-foreground" : "text-foreground",
                    )}
                  >
                    {modelStatus.name}
                  </span>
                  {modelStatus.meta && (
                    <span className="truncate text-[11px] text-muted-foreground tabular-nums leading-tight">
                      {modelStatus.meta}
                    </span>
                  )}
                </div>
              )}
              {state.isBatteryRoute && (
                <Button
                  className="w-full"
                  disabled={state.batteryModelLoading}
                  onClick={() => controls.loadBatteryModel()}
                  size="xs"
                  variant="outline"
                >
                  {state.batteryModelLoading ? "Loading battery…" : "Load NGEN battery"}
                </Button>
              )}
            </div>

            {state.batteryStackAvailable && (
              <div className="flex flex-col gap-4">
                <Label className="gap-2.5 text-xs">
                  <Switch
                    checked={state.batteryStackEnabled}
                    onCheckedChange={(checked: boolean) => controls.setBatteryStackEnabled(checked)}
                  />
                  Battery stacking
                </Label>
                {state.batteryStackEnabled && (
                  <>
                    {batteryCountControl}
                    <Label className="gap-2.5 text-xs">
                      <Switch
                        checked={state.batteryStackAnimation}
                        onCheckedChange={(checked: boolean) => controls.setBatteryStackAnimation(checked)}
                      />
                      Animate stacking
                    </Label>
                    <Button
                      disabled={!state.batteryStackAnimation}
                      onClick={() => controls.replayBatteryStack()}
                      size="xs"
                      variant="outline"
                    >
                      Replay stack animation
                    </Button>
                  </>
                )}
              </div>
            )}

            <div className="flex items-center gap-4">
              <Field className="flex-1 gap-3">
                <div className="flex w-full items-center justify-between gap-1">
                  <FieldLabel className="text-xs sm:text-xs">Model size</FieldLabel>
                  <span className="text-muted-foreground text-xs tabular-nums">{Math.round(state.cubeSize)}%</span>
                </div>
                <Slider
                  max={state.cubeSizeMax}
                  min={state.cubeSizeMin}
                  onValueChange={(value: number | readonly number[]) => {
                    const clamped = controls.setCubeSizePercent(value as number);
                    setState((s) => ({ ...s, cubeSize: clamped }));
                  }}
                  value={state.cubeSize}
                />
              </Field>
            </div>

            <div className="flex items-center gap-4">
              <Field className="flex-1 gap-3">
                <div className="flex w-full items-center justify-between gap-1">
                  <FieldLabel className="text-xs sm:text-xs">Model X position</FieldLabel>
                  <span className="text-muted-foreground text-xs tabular-nums">{Math.round(state.modelOffsetX)}</span>
                </div>
                <Slider
                  max={state.modelOffsetMax}
                  min={state.modelOffsetMin}
                  onValueChange={(value: number | readonly number[]) => {
                    const clamped = controls.setModelOffsetXPercent(value as number);
                    setState((s) => ({ ...s, modelOffsetX: clamped }));
                  }}
                  value={state.modelOffsetX}
                />
              </Field>
            </div>

            <div className="flex items-center gap-4">
              <Field className="flex-1 gap-3">
                <div className="flex w-full items-center justify-between gap-1">
                  <FieldLabel className="text-xs sm:text-xs">Model Y position</FieldLabel>
                  <span className="text-muted-foreground text-xs tabular-nums">{Math.round(state.modelOffsetY)}</span>
                </div>
                <Slider
                  disabled={state.editingDefaultView}
                  max={state.modelOffsetMax}
                  min={state.modelOffsetMin}
                  onValueChange={(value: number | readonly number[]) => {
                    const clamped = controls.setModelOffsetYPercent(value as number);
                    setState((s) => ({ ...s, modelOffsetY: clamped }));
                  }}
                  value={state.modelOffsetY}
                />
              </Field>
            </div>

            <div className="flex items-center gap-2">
              <Button
                className="ml-auto"
                onClick={() => { controls.resetModelPosition(); setState((s) => ({ ...s, modelOffsetX: 0, modelOffsetY: 0 })); }}
                onPointerDown={resetPositionIconPress.onPointerDown}
                onPointerLeave={resetPositionIconPress.onPointerLeave}
                onPointerUp={resetPositionIconPress.onPointerUp}
                size="xs"
                variant="outline"
              >
                <UndoDotIcon className="size-3" ref={resetPositionIconPress.ref} />
                Reset position
              </Button>
              <Button
                onClick={() => {
                  const clamped = controls.setCubeSizePercent(100);
                  setState((s) => ({ ...s, cubeSize: clamped }));
                }}
                onPointerDown={resetSizeIconPress.onPointerDown}
                onPointerLeave={resetSizeIconPress.onPointerLeave}
                onPointerUp={resetSizeIconPress.onPointerUp}
                size="xs"
                variant="outline"
              >
                <UndoDotIcon className="size-3" ref={resetSizeIconPress.ref} />
                Reset size
              </Button>
            </div>

            {cameraTargetsPhase !== "closed" && (
              <div
                className={cn(
                  "t-reveal",
                  cameraTargetsPhase === "open" && "is-open",
                  cameraTargetsPhase === "closing" && "is-closing",
                )}
              >
              <div className="flex flex-col gap-6">
                <Separator />
                <h2 className="font-semibold text-base text-foreground tracking-[-0.011em]">Camera Targets</h2>
                <div className="flex flex-col gap-4">
                  {/* Keep in sync with CAMERA_TARGET_SLOT_COUNT in main.js —
                      all 7 slots always render (most just "— none —" until
                      assigned) rather than growing/shrinking with however
                      many are in use, so the keyboard shortcuts (1-7) and
                      this list stay predictable. */}
                  {[0, 1, 2, 3, 4, 5, 6].map((slotIndex) => (
                    <div className="flex flex-col gap-1.5" key={slotIndex}>
                      <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
                        Target {slotIndex + 1}
                        <Kbd className="h-auto min-w-0 w-auto p-1 text-[10px] leading-none">{slotIndex + 1}</Kbd>
                      </span>
                      <div className="flex items-center gap-2">
                        <select
                          className="h-7 min-w-0 flex-1 truncate rounded-md border border-border bg-background px-2 text-xs"
                          onChange={(event) => {
                            const objectName = event.target.value || null;
                            controls.setCameraTargetSlot(slotIndex, objectName);
                            setState((s) => {
                              const cameraTargetSlots = [...s.cameraTargetSlots];
                              cameraTargetSlots[slotIndex] = objectName;
                              return { ...s, cameraTargetSlots };
                            });
                          }}
                          value={state.cameraTargetSlots?.[slotIndex] ?? ""}
                        >
                          <option value="">— none —</option>
                          {sortedCustomModelObjectNames.map((name: string) => (
                            <option key={name} value={name}>
                              {name}
                            </option>
                          ))}
                        </select>
                        <Button
                          className="shrink-0 transition-[color,background-color,border-color,box-shadow,scale] duration-150"
                          disabled={!state.cameraTargetSlots?.[slotIndex] || state.editingDefaultView}
                          onClick={() => {
                            controls.goToCameraTarget(slotIndex);
                            setState((s) => ({ ...s, cameraTargetActiveIndex: slotIndex }));
                          }}
                          onPointerDown={() => goIconRefs.current[slotIndex]?.startAnimation()}
                          onPointerLeave={() => goIconRefs.current[slotIndex]?.stopAnimation()}
                          onPointerUp={() => goIconRefs.current[slotIndex]?.stopAnimation()}
                          size="xs"
                          variant={state.cameraTargetActiveIndex === slotIndex ? "default" : "outline"}
                        >
                          Go
                          <ArrowBigRightDashIcon
                            className="size-3"
                            ref={(el) => {
                              goIconRefs.current[slotIndex] = el;
                            }}
                          />
                        </Button>
                      </div>
                    </div>
                  ))}
                  <div className="flex flex-col gap-1.5">
                    <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
                      Default position
                      <Kbd className="h-auto min-w-0 w-auto p-1 text-[10px] leading-none">0</Kbd>
                    </span>
                    {state.editingDefaultView && (
                      <p className="text-[11px] text-muted-foreground leading-snug">
                        Pan and zoom the camera, then click Done to save this as the default.
                      </p>
                    )}
                    <div className="flex items-center gap-2">
                      <Button
                        className="min-w-0 flex-1"
                        onClick={() => controls.setEditingDefaultView(!state.editingDefaultView)}
                        onPointerDown={setDefaultViewIconPress.onPointerDown}
                        onPointerLeave={setDefaultViewIconPress.onPointerLeave}
                        onPointerUp={setDefaultViewIconPress.onPointerUp}
                        size="xs"
                        variant={state.editingDefaultView ? "default" : "outline"}
                      >
                        <MapPinIcon className="size-3" ref={setDefaultViewIconPress.ref} />
                        {state.editingDefaultView ? "Done editing" : "Edit default position"}
                      </Button>
                      <Button
                        className="shrink-0"
                        disabled={!state.hasDefaultCameraView || state.editingDefaultView}
                        onClick={() => controls.goToDefaultCameraView()}
                        onPointerDown={() => goDefaultViewIconRef.current?.startAnimation()}
                        onPointerLeave={() => goDefaultViewIconRef.current?.stopAnimation()}
                        onPointerUp={() => goDefaultViewIconRef.current?.stopAnimation()}
                        size="xs"
                        variant="outline"
                      >
                        Go
                        <ArrowBigRightDashIcon className="size-3" ref={goDefaultViewIconRef} />
                      </Button>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <Button
                    className="ml-auto"
                    disabled={state.cameraTargetActiveIndex == null || state.editingDefaultView}
                    onClick={() => {
                      controls.resetCameraTarget();
                      setState((s) => ({ ...s, cameraTargetActiveIndex: null }));
                    }}
                    onPointerDown={resetViewIconPress.onPointerDown}
                    onPointerLeave={resetViewIconPress.onPointerLeave}
                    onPointerUp={resetViewIconPress.onPointerUp}
                    size="xs"
                    variant="outline"
                  >
                    <UndoDotIcon className="size-3" ref={resetViewIconPress.ref} />
                    Reset view
                  </Button>
                </div>
                <Label className="gap-2.5 text-xs">
                  <Switch
                    checked={!!state.showCameraTargetBoxes}
                    onCheckedChange={(checked: boolean) => {
                      controls.setShowCameraTargetBoxes(checked);
                      setState((s) => ({ ...s, showCameraTargetBoxes: checked }));
                    }}
                  />
                  Show target bounding boxes
                </Label>
                <Label className="gap-2.5 text-xs">
                  <Switch
                    checked={!!state.showTargetMaterials}
                    onCheckedChange={(checked: boolean) => {
                      controls.setShowTargetMaterials(checked);
                      setState((s) => ({ ...s, showTargetMaterials: checked }));
                    }}
                  />
                  Show target materials
                </Label>
              </div>
              </div>
            )}

            <Separator />

            <h2 className="font-semibold text-base text-foreground tracking-[-0.011em]">Shader Controls</h2>

            <div className="flex items-center gap-4">
              <Field className="flex-1 gap-3">
                <FieldLabel className="text-xs sm:text-xs">Shader theme</FieldLabel>
                {/* Segmented control — one sliding thumb (see
                    .t-segmented-thumb in index.css) instead of two
                    independent filled/outline buttons. */}
                <div className="relative grid h-8 w-full grid-cols-2 rounded-lg bg-input p-0.5 sm:h-7">
                  <span
                    aria-hidden="true"
                    className="t-segmented-thumb pointer-events-none absolute inset-y-0.5 left-0.5 w-[calc(50%-2px)] rounded-md bg-primary shadow-xs"
                    style={{ translate: state.shaderTheme === "light" ? "100% 0" : "0 0" }}
                  />
                  {(["dark", "light"] as const).map((theme) => (
                    <button
                      aria-pressed={state.shaderTheme === theme}
                      className={cn(
                        "relative cursor-pointer rounded-md font-medium text-sm outline-none transition-[color,scale] duration-100 ease-out focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97] sm:text-xs",
                        state.shaderTheme === theme ? "text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                      )}
                      key={theme}
                      onClick={() => {
                        controls.setShaderTheme(theme);
                        setState((s) => ({ ...s, shaderTheme: theme }));
                      }}
                      type="button"
                    >
                      {theme === "dark" ? "Dark" : "Light"}
                    </button>
                  ))}
                </div>
              </Field>
            </div>

            {/* Pattern sliders tucked behind a "Customise patterns"
                disclosure — same pattern as the photo card's Customise link:
                fine-tuning, one level below the common controls. */}
            <button
              aria-expanded={patternsOpen}
              className="-mt-2 flex w-fit cursor-pointer items-center gap-1 rounded-sm text-muted-foreground text-xs outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => setPatternsOpen((open) => !open)}
              type="button"
            >
              Customise patterns
              <ChevronDown
                className={cn(
                  "size-3.5 transition-transform duration-200 ease-out motion-reduce:transition-none",
                  patternsOpen && "rotate-180",
                )}
              />
            </button>
            {patternsPhase !== "closed" && (
              <div
                className={cn(
                  "t-reveal -my-3",
                  patternsPhase === "open" && "is-open",
                  patternsPhase === "closing" && "is-closing",
                )}
              >
                {/* Padding gives the sliders' thumbs and focus rings room
                    inside .t-reveal's clipping child. */}
                <div className="-mx-1 flex flex-col gap-6 px-1 py-3">
                <div className="flex items-center gap-4">
                  <Field className="flex-1 gap-3">
                    <div className="flex w-full items-center justify-between gap-1">
                      <FieldLabel className="text-xs sm:text-xs">Line frequency</FieldLabel>
                      <span className="text-muted-foreground text-xs tabular-nums">{state.lineFrequency}</span>
                    </div>
                    <Slider
                      max={state.lineFrequencyMax}
                      min={state.lineFrequencyMin}
                      onValueChange={(value: number | readonly number[]) => {
                        const clamped = controls.setLineFrequency(value as number);
                        setState((s) => ({ ...s, lineFrequency: clamped }));
                      }}
                      value={state.lineFrequency}
                    />
                  </Field>
                </div>

                <div className="flex items-center gap-4">
                  <Field className="flex-1 gap-3">
                    <div className="flex w-full items-center justify-between gap-1">
                      <FieldLabel className="text-xs sm:text-xs">Dot frequency</FieldLabel>
                      <span className="text-muted-foreground text-xs tabular-nums">{state.dotFrequency}</span>
                    </div>
                    <Slider
                      max={state.dotFrequencyMax}
                      min={state.dotFrequencyMin}
                      onValueChange={(value: number | readonly number[]) => {
                        const clamped = controls.setDotFrequency(value as number);
                        setState((s) => ({ ...s, dotFrequency: clamped }));
                      }}
                      value={state.dotFrequency}
                    />
                  </Field>
                </div>

                <div className="flex items-center gap-4">
                  <Field className="flex-1 gap-3">
                    <div className="flex w-full items-center justify-between gap-1">
                      <FieldLabel className="text-xs sm:text-xs">Dot size</FieldLabel>
                      <span className="text-muted-foreground text-xs tabular-nums">{state.dotSize}%</span>
                    </div>
                    <Slider
                      max={state.dotSizeMax}
                      min={state.dotSizeMin}
                      onValueChange={(value: number | readonly number[]) => {
                        const clamped = controls.setDotSizePercent(value as number);
                        setState((s) => ({ ...s, dotSize: clamped }));
                      }}
                      value={state.dotSize}
                    />
                  </Field>
                </div>

                <div className="flex items-center gap-4">
                  <Field className="flex-1 gap-3">
                    <div className="flex w-full items-center justify-between gap-1">
                      <FieldLabel className="text-xs sm:text-xs">Plus frequency</FieldLabel>
                      <span className="text-muted-foreground text-xs tabular-nums">{state.plusFrequency}</span>
                    </div>
                    <Slider
                      max={state.plusFrequencyMax}
                      min={state.plusFrequencyMin}
                      onValueChange={(value: number | readonly number[]) => {
                        const clamped = controls.setPlusFrequency(value as number);
                        setState((s) => ({ ...s, plusFrequency: clamped }));
                      }}
                      value={state.plusFrequency}
                    />
                  </Field>
                </div>

                <div className="flex items-center gap-4">
                  <Field className="flex-1 gap-3">
                    <div className="flex w-full items-center justify-between gap-1">
                      <FieldLabel className="text-xs sm:text-xs">Plus size</FieldLabel>
                      <span className="text-muted-foreground text-xs tabular-nums">{state.plusSize}%</span>
                    </div>
                    <Slider
                      max={state.plusSizeMax}
                      min={state.plusSizeMin}
                      onValueChange={(value: number | readonly number[]) => {
                        const clamped = controls.setPlusSizePercent(value as number);
                        setState((s) => ({ ...s, plusSize: clamped }));
                      }}
                      value={state.plusSize}
                    />
                  </Field>
                </div>
                </div>
              </div>
            )}

            <Separator />

            {/* No light controls on the root route (see isPlainRoute in main.js). */}
            {!state.isPlainRoute && (
            <>
            <h2 className="font-semibold text-base text-foreground tracking-[-0.011em]">Light controls</h2>

            <div className="flex items-center gap-4">
              <Field className="flex-1 gap-3">
                <div className="flex w-full items-center justify-between gap-1">
                  <FieldLabel className="text-xs sm:text-xs">Light azimuth</FieldLabel>
                  <span className="text-muted-foreground text-xs tabular-nums">{state.lightAzimuth}°</span>
                </div>
                <Slider
                  max={state.lightAzimuthMax}
                  min={state.lightAzimuthMin}
                  onValueChange={(value: number | readonly number[]) => {
                    const azimuth = value as number;
                    controls.setLightAzimuth(azimuth);
                    setState((s) => ({ ...s, lightAzimuth: azimuth }));
                  }}
                  value={state.lightAzimuth}
                />
              </Field>
            </div>

            <div className="flex items-center gap-4">
              <Field className="flex-1 gap-3">
                <div className="flex w-full items-center justify-between gap-1">
                  <FieldLabel className="text-xs sm:text-xs">Light elevation</FieldLabel>
                  <span className="text-muted-foreground text-xs tabular-nums">{state.lightElevation}°</span>
                </div>
                <Slider
                  max={state.lightElevationMax}
                  min={state.lightElevationMin}
                  onValueChange={(value: number | readonly number[]) => {
                    const elevation = value as number;
                    controls.setLightElevation(elevation);
                    setState((s) => ({ ...s, lightElevation: elevation }));
                  }}
                  value={state.lightElevation}
                />
              </Field>
            </div>

            <div className="flex items-center gap-4">
              <Field className="flex-1 gap-3">
                <div className="flex w-full items-center justify-between gap-1">
                  <FieldLabel className="text-xs sm:text-xs">Light intensity</FieldLabel>
                  <span className="text-muted-foreground text-xs tabular-nums">{state.lightIntensity}%</span>
                </div>
                <Slider
                  max={state.lightIntensityMax}
                  min={state.lightIntensityMin}
                  onValueChange={(value: number | readonly number[]) => {
                    const clamped = controls.setLightIntensityPercent(value as number);
                    setState((s) => ({ ...s, lightIntensity: clamped }));
                  }}
                  value={state.lightIntensity}
                />
              </Field>
            </div>

            <Separator />
            </>
            )}

            <h2 className="font-semibold text-base text-foreground tracking-[-0.011em]">Interaction Controls</h2>

            {/* The hover orbit is off on /battery, so its switch is too. */}
            {!state.isBatteryRoute && (
            <div className="flex items-center gap-4">
              <Label className="gap-2.5 text-xs">
                <Switch
                  checked={!state.hoverMovementPaused}
                  onCheckedChange={(checked: boolean) => {
                    const paused = !checked;
                    controls.setHoverMovementPaused(paused);
                    setState((s) => ({ ...s, hoverMovementPaused: paused }));
                  }}
                />
                Hover
              </Label>
            </div>
            )}

            <div className="flex items-center gap-4">
              <Label className="gap-2.5 text-xs">
                <Switch
                  checked={!state.rotationDisabled}
                  onCheckedChange={(checked: boolean) => {
                    const disabled = !checked;
                    controls.setRotationDisabled(disabled);
                    setState((s) => ({ ...s, rotationDisabled: disabled }));
                  }}
                />
                Rotation
                <Kbd className="h-auto min-w-0 w-auto p-1 text-[10px] leading-none">R</Kbd>
              </Label>
            </div>

            <div className="flex items-center gap-2">
              <Button
                className="ml-auto"
                onClick={() => controls.resetRotation()}
                onPointerDown={resetRotationIconPress.onPointerDown}
                onPointerLeave={resetRotationIconPress.onPointerLeave}
                onPointerUp={resetRotationIconPress.onPointerUp}
                size="xs"
                variant="outline"
              >
                <UndoDotIcon className="size-3" ref={resetRotationIconPress.ref} />
                Reset rotation
                <Kbd className="h-auto min-w-0 w-auto p-1 text-[10px] leading-none">⇧R</Kbd>
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Figma: N-GEN / Shuffle Icon Card - Big (node 4992:24139) — a static
          info card, /scroll-only (see isScrollRoute below). Unlike the panel
          chrome above, this is always visible on that route (not tied to
          panelPhase — H can't hide it) and sits below the control panels on
          the z-axis (z-0, under their z-10) so a panel overlapping it in the
          corner stacks on top. At sm and up this is back to the original
          bottom-left-corner treatment: fixed 727px width, 24px off the
          left/bottom edges, icon tile beside the text. Below sm it's
          full-width (left-6 right-6, sm:right-auto cancels that) and stacks
          vertically instead, icon tile above the text (its own row wrapper
          switches from flex-row to flex-col — see cardRowRef's classes)
          since there's no room for it beside the text at that width. These
          NGEN brand colors are real project tokens (gray-50/100/500/900,
          green-600 — see src/index.css's @theme block, ported from
          170-1-ngen-spletna-stran's own theme.css; BLUEPRINT_THEMES/
          BLUEPRINT_FILL_COLOR_GREEN in main.js carry the same palette on the
          3D side, as literal values there since that's WebGL, not CSS).

          .t-stagger lives on this outer row (not just the text column) so
          the icon can be a .t-stagger-line too — same directional enter/exit
          as the text below it. The tile itself isn't a stagger line, so it
          stays put — only the glyph inside it moves. Three elements crossfade
          together off the same cardContentReveal.phase signal, swapping
          which one wears the brand green: settled on "shown", the card is
          its resting gray-50, the tile is green-600, and the glyph is
          gray-900 for contrast on that green. For as long as the copy is
          mid-transition or hasn't appeared yet
          ("hiding"/"enterStart"/"hidden"), that inverts — card goes white,
          tile goes to gray-100 (the card's own border tone) the card just
          vacated, and the glyph itself picks up green-600 instead — same
          signal the copy's own exit/enter already uses, just read directly
          rather than threaded through main.js/notifyModelState. */}
      {state.isScrollRoute && (
      <div
        ref={introCardRef}
        className={cn(
          "t-stagger fixed left-6 right-6 bottom-6 z-0 overflow-hidden rounded-[36px] border-[0.5px] border-gray-100 p-6 transition-[height,background-color] ease-out sm:right-auto sm:w-[727px] sm:max-w-[calc(100vw-3rem)] sm:p-3",
          cardContentReveal.phase === "shown" ? "bg-gray-50" : "bg-white",
          cardContentReveal.phase === "shown" && "is-shown",
          cardContentReveal.phase === "hiding" && "is-hiding",
          (cardContentReveal.phase === "enterStart" || cardContentReveal.phase === "hidden") && "is-entering",
        )}
        style={{
          transform: "translateY(64px)",
          opacity: 0,
          filter: "blur(4px)",
          height: cardHeight !== null ? `${cardHeight}px` : undefined,
          transitionDuration: `${cardHeightDurationMs}ms`,
        }}
        data-direction={cardContentReveal.direction}
      >
        {/* The measured row — icon + text together, see cardRowRef's own
            comment above for why the icon has to be part of what's
            measured. No explicit sizing of its own; it's exactly as tall as
            its children need, which is what the outer card's height chases. */}
        <div ref={cardRowRef} className="flex w-full flex-col items-start gap-6 sm:flex-row sm:items-start sm:gap-2">
          <div
            className={cn(
              // Sizing (aspect-square w-30 sm:w-50 = 120px mobile, 200px at
              // sm+) matches the NGEN ScrambleCard molecule's own "default"
              // variant image tile (170-1-ngen-spletna-stran's
              // src/components/molecules/ScrambleCard/ScrambleCard.tsx) —
              // this card is styled off that component. Colors/radius stay
              // this card's own already brand-token-matched values (see the
              // outer comment) rather than ScrambleCard's own defaults,
              // since those were verified exact hex matches to this card's
              // specific Figma node, a distinct (larger) variant.
              // hidden below sm: the tile costs real vertical room stacked
              // above the text on narrow screens (see cardRowRef's own
              // flex-col -> sm:flex-row switch above) — dropping it there
              // buys the card more room without touching the sm+ desktop
              // layout, which keeps it exactly as before.
              "relative hidden aspect-square w-30 shrink-0 items-center justify-center overflow-hidden rounded-[24px] transition-colors duration-300 sm:flex sm:w-50",
              cardContentReveal.phase === "shown" ? "bg-green-600" : "bg-gray-100",
            )}
          >
            {/* Per-step icon (cardContent.iconPath, from CARD_STEPS in
                src/content/cardSteps.ts — CMS-editable along with the copy,
                56x56 viewBox, single fill path) — currentColor instead of a
                hardcoded fill so it can crossfade with the tile's own bg
                color (see this card's outer comment): gray-900 for contrast
                once the tile settles green, green-600 itself while the
                tile's mid-transition and grey. Centered via
                the flex parent (not its own absolute+translate) specifically
                so transform stays free for .t-stagger-line's own
                translateY. Keyed by displayedIndex so swapping icons is part
                of the same exit/enter cycle as the text next to it, not a
                mid-transition snap. */}
            <svg
              key={cardContentReveal.displayedIndex}
              aria-hidden="true"
              className={cn(
                "t-stagger-line t-stagger-line--1 size-[56px] transition-colors duration-300",
                cardContentReveal.phase === "shown" ? "text-gray-900" : "text-green-600",
              )}
              fill="none"
              viewBox="0 0 56 56"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path d={cardContent.iconPath} fill="currentColor" />
            </svg>
          </div>
          <div className="flex w-full min-w-0 flex-1 flex-col items-start gap-3 sm:justify-between sm:gap-4 sm:self-stretch sm:p-5">
            {/* super-title (src/index.css, ported from NGEN's headings.css)
                is exactly this set of utilities — matches ScrambleCard's own
                tag styling too, since that is what super-title is. */}
            <p className="t-stagger-line t-stagger-line--2 super-title">
              {cardContent.step}
            </p>
            <div className="flex w-full flex-col items-start gap-1.5">
              {/* leading-tight resolves to 1.2 (see its @theme override in
                  src/index.css, ported from theme.css) — same value as
                  ScrambleCard's own title, which relies on that same
                  override. font-sans made explicit here (and on the body
                  text below) rather than left to inherit from html's own
                  base rule — matches ScrambleCard's title/body, which also
                  render with no explicit font class, inheriting the same
                  font-primary/Inter default from body in site.css. */}
              <p className="t-stagger-line t-stagger-line--3 font-medium font-sans text-2xl text-gray-900 leading-tight tracking-tight">
                {cardContent.title}
              </p>
              {/* text-sm/leading-normal match ScrambleCard's own body-text
                  sizing exactly (text-sm = 14px, leading-normal = 1.5 — same
                  values as the previous arbitrary text-[14px]/leading-[1.5]
                  here). No font-weight class, matching ScrambleCard's own
                  body text too — regular weight, not font-medium. */}
              <p className="t-stagger-line t-stagger-line--4 font-sans text-sm text-gray-500 leading-normal">
                {cardContent.text}
              </p>
            </div>
          </div>
        </div>
      </div>
      )}
    </>
  );
}
