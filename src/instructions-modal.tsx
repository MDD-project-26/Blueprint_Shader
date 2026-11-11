import { Camera, Info, type LucideIcon, Move, Palette, Upload, ZoomIn } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";

// Step-by-step guide shown on the root route (index.html, see isPlainRoute
// in main.js): opens on load, Next walks through one topic per step, and
// the last step's "I understand" closes it. The I key reopens it any time
// (wired up in panel.tsx, which owns the open state and the reveal phase).


// Keycap look (raised bottom edge) so a key reads as something you press,
// not as inline code.
function K({ children }: { children: ReactNode }) {
  return (
    <Kbd className="mx-0.5 h-auto min-w-[1.5em] w-auto border border-white/10 bg-white/[0.07] px-1.5 py-0.5 align-[0.05em] font-medium text-[11px] text-foreground leading-none shadow-[inset_0_-1px_0_rgb(255_255_255/0.08),0_1px_0_rgb(0_0_0/0.4)]">
      {children}
    </Kbd>
  );
}

type Step = { icon: LucideIcon; title: string; body: ReactNode };

const STEPS: Step[] = [
  {
    icon: Move,
    title: "Move around",
    body: (
      <>
        <p>
          Hold <K>Space</K> to rise into a top-down view, then click and drag to move the model across the ground.
          Release <K>Space</K> to drop back to the normal angle. The model stays where you moved it.
        </p>
        <p>
          <strong className="text-foreground">Reset position</strong> in the Model Controls panel brings the model back
          to the center.
        </p>
      </>
    ),
  },
  {
    icon: ZoomIn,
    title: "Zoom in and out",
    body: (
      <>
        <p>
          Scroll with your mouse wheel, or swipe with two fingers or pinch on a trackpad. The view zooms toward the
          crosshair in the middle of the screen.
        </p>
        <p>
          You can also drag the <strong className="text-foreground">Model size</strong> slider in the Model Controls
          panel. <strong className="text-foreground">Reset size</strong> takes you back to 100%.
        </p>
      </>
    ),
  },
  {
    icon: Upload,
    title: "Load your own model",
    body: (
      <>
        <p>
          Click <strong className="text-foreground">Load model…</strong> in the Model Controls panel and pick an{" "}
          <code>.obj</code> file. Select its <code>.mtl</code> file at the same time to keep the materials.
        </p>
        <p>
          Or drag the <code>.obj</code> and <code>.mtl</code> files anywhere onto the page and drop them. The new model
          replaces the current one.
        </p>
      </>
    ),
  },
  {
    icon: Camera,
    title: "Take a photo",
    body: (
      <>
        <p>
          Press <K>P</K>, or click the photo mode pill at the bottom, to enter photo mode. Click{" "}
          <strong className="text-foreground">Capture</strong> in the card that opens, or press <K>Enter</K>, to save the
          current view as a PNG.
        </p>
        <p>
          Turn on <strong className="text-foreground">@2x resolution</strong> for a larger image. The card shows the exact
          size you&rsquo;ll get, which follows the shape of your browser window. Under{" "}
          <strong className="text-foreground">Customise</strong> you can change the line width, but this can make results
          that don&rsquo;t match the brand, so use it with care.
        </p>
        <p>
          Press <K>P</K> again, <K>Esc</K>, or the card&rsquo;s close button to leave photo mode.
        </p>
      </>
    ),
  },
  {
    icon: Palette,
    title: "Change the shader theme",
    body: (
      <>
        <p>
          In the Model Controls panel, under <strong className="text-foreground">Shader Controls</strong>, switch Shader
          theme between <strong className="text-foreground">Dark</strong> and{" "}
          <strong className="text-foreground">Light</strong>. Your choice is remembered next time.
        </p>
      </>
    ),
  },
  {
    icon: Info,
    title: "Open this guide again",
    body: (
      <>
        <p>
          Press <K>I</K> at any time to bring these instructions back.
        </p>
        <p>
          Press <K>H</K> to hide the panels and everything else on screen for a clean view. Press <K>H</K> again to bring
          them back.
        </p>
      </>
    ),
  },
];

export function InstructionsModal({
  phase,
  onClose,
}: {
  phase: "closed" | "entering" | "open" | "closing";
  onClose: () => void;
}) {
  const [step, setStep] = useState(0);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const isLast = step === STEPS.length - 1;

  // Every opening starts from the first topic.
  useEffect(() => {
    if (phase === "entering") setStep(0);
  }, [phase]);

  // Keep focus on the primary action so Enter/Space advance the steps.
  useEffect(() => {
    if (phase === "open") primaryRef.current?.focus();
  }, [phase, step]);

  // While the guide is open, the scene's own shortcuts (P, Enter, Space, digits,
  // arrows…) must not fire behind it. A capture listener on window runs
  // before main.js's bubbling window listeners, so stopping propagation here
  // is enough; default actions (Tab focus moves, Enter/Space activating the
  // focused button) still happen.
  useEffect(() => {
    if (phase === "closed" || phase === "closing") return;
    const onKeydown = (event: KeyboardEvent) => {
      event.stopImmediatePropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "ArrowRight" && !isLast) {
        setStep((s) => s + 1);
      } else if (event.key === "ArrowLeft") {
        setStep((s) => Math.max(0, s - 1));
      }
    };
    window.addEventListener("keydown", onKeydown, true);
    return () => window.removeEventListener("keydown", onKeydown, true);
  }, [phase, isLast, onClose]);

  if (phase === "closed") return null;

  return (
    <div
      className={cn(
        "t-overlay-backdrop fixed inset-0 z-30 flex items-center justify-center bg-black/55 px-4 backdrop-blur-[2px]",
        phase === "open" && "is-open",
        phase === "closing" && "is-closing",
      )}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <div
        aria-labelledby="instructions-title"
        aria-modal="true"
        className={cn(
          "t-modal t-guide-surface flex w-full max-w-[26rem] flex-col overflow-hidden rounded-[28px] border border-white/10 bg-popover/90 text-popover-foreground shadow-[0_24px_64px_-12px_rgb(0_0_0/0.6)] backdrop-blur-xl",
          phase === "open" && "is-open",
          phase === "closing" && "is-closing",
        )}
        role="dialog"
      >
        <div className="flex items-center justify-between px-6 pt-5">
          <span className="text-muted-foreground text-xs tabular-nums">
            {step + 1} of {STEPS.length}
          </span>
          <button
            className="-mr-2 cursor-pointer rounded-md px-2 py-1 text-muted-foreground text-xs outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onClose}
            type="button"
          >
            Skip
          </button>
        </div>

        {/* Every step sits in the same grid cell, so the card is always as
            tall as the longest step and the buttons never move. Steps
            before the current one rest off to the left, later ones to the
            right, so Next slides content in from the right and Back from
            the left. */}
        <div className="grid px-6 pt-4 pb-6" aria-live="polite">
          {STEPS.map((s, i) => {
            const Icon = s.icon;
            return (
              <div
                aria-hidden={i !== step}
                className="t-guide-step col-start-1 row-start-1 flex flex-col gap-4"
                data-position={i === step ? "current" : i < step ? "before" : "after"}
                key={s.title}
              >
                <div className="flex size-11 items-center justify-center rounded-[14px] border border-white/10 bg-white/[0.06] text-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.08)]">
                  <Icon aria-hidden="true" className="size-5" strokeWidth={1.75} />
                </div>
                <h2
                  className="font-semibold text-[1.375rem] text-foreground leading-tight tracking-[-0.015em]"
                  id={i === step ? "instructions-title" : undefined}
                >
                  {s.title}
                </h2>
                <div className="flex flex-col gap-2.5 text-foreground/70 text-sm leading-relaxed [&_code]:text-foreground [&_strong]:font-medium">
                  {s.body}
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between gap-3 border-white/[0.06] border-t bg-white/[0.02] px-4 py-3">
          <Button
            className={cn("t-press min-w-20", step === 0 && "invisible")}
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            size="sm"
            tabIndex={step === 0 ? -1 : undefined}
            variant="ghost"
          >
            Back
          </Button>
          {/* Page control: the current step stretches into a pill. Each dot
              jumps straight to its step. */}
          <div className="flex items-center gap-1.5">
            {STEPS.map((s, i) => (
              <button
                aria-current={i === step ? "step" : undefined}
                aria-label={`Step ${i + 1}: ${s.title}`}
                className="group flex h-6 cursor-pointer items-center outline-none"
                key={s.title}
                onClick={() => setStep(i)}
                type="button"
              >
                <span
                  className={cn(
                    "t-guide-dot block h-1.5 rounded-full group-focus-visible:ring-2 group-focus-visible:ring-ring",
                    i === step ? "w-5 bg-foreground" : "w-1.5 bg-foreground/25 group-hover:bg-foreground/50",
                  )}
                />
              </button>
            ))}
          </div>
          <Button className="t-press min-w-28" onClick={() => (isLast ? onClose() : setStep((s) => s + 1))} ref={primaryRef} size="sm">
            {isLast ? "I understand" : "Next"}
          </Button>
        </div>
      </div>
    </div>
  );
}
