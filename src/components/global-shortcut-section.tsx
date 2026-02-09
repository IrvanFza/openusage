import { useEffect, useRef, useState } from "react"
import { Checkbox } from "@/components/ui/checkbox"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { GlobalShortcut } from "@/lib/settings"

// Convert internal shortcut format to display format
// e.g., "CommandOrControl+Shift+U" -> "Cmd + Shift + U"
function formatShortcutForDisplay(shortcut: string): string {
  return shortcut
    .replace(/CommandOrControl/g, "Cmd")
    .replace(/Command/g, "Cmd")
    .replace(/Control/g, "Ctrl")
    .replace(/Option/g, "Opt")
    .replace(/Alt/g, "Opt")
    .replace(/\+/g, " + ")
}

// Modifier codes (using event.code for reliable detection)
const MODIFIER_CODES = new Set([
  "MetaLeft", "MetaRight",
  "ControlLeft", "ControlRight",
  "AltLeft", "AltRight",
  "ShiftLeft", "ShiftRight",
])

// Normalize modifier code to base name
function normalizeModifierCode(code: string): string {
  if (code.startsWith("Meta")) return "Meta"
  if (code.startsWith("Control")) return "Control"
  if (code.startsWith("Alt")) return "Alt"
  if (code.startsWith("Shift")) return "Shift"
  return code
}

// Convert event.code to a display-friendly key name
function codeToDisplayKey(code: string): string {
  // Handle letter keys (KeyA -> A)
  if (code.startsWith("Key")) return code.slice(3)
  // Handle digit keys (Digit1 -> 1)
  if (code.startsWith("Digit")) return code.slice(5)
  // Handle numpad (Numpad1 -> Num1)
  if (code.startsWith("Numpad")) return "Num" + code.slice(6)
  // Handle special keys
  const specialKeys: Record<string, string> = {
    Space: "Space",
    Enter: "Enter",
    Backspace: "Backspace",
    Tab: "Tab",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Escape: "Esc",
    Delete: "Del",
    Insert: "Ins",
    Home: "Home",
    End: "End",
    PageUp: "PgUp",
    PageDown: "PgDn",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Backquote: "`",
    Minus: "-",
    Equal: "=",
  }
  return specialKeys[code] || code
}

// Convert event.code to Tauri shortcut key format
function codeToTauriKey(code: string): string {
  if (code.startsWith("Key")) return code.slice(3)
  if (code.startsWith("Digit")) return code.slice(5)
  const specialKeys: Record<string, string> = {
    Space: "Space",
    Enter: "Return",
    Backspace: "Backspace",
    Tab: "Tab",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Delete: "Delete",
    Insert: "Insert",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
  }
  return specialKeys[code] || code
}

// Build shortcut array from currently pressed keys (modifiers + main key)
function buildShortcutFromCodes(codes: Set<string>): { display: string; tauri: string | null } {
  const modifiers: string[] = []
  const displayMods: string[] = []
  let mainCode: string | null = null

  for (const code of codes) {
    if (MODIFIER_CODES.has(code)) {
      const normalized = normalizeModifierCode(code)
      if (normalized === "Meta" || normalized === "Control") {
        if (!modifiers.includes("CommandOrControl")) {
          modifiers.push("CommandOrControl")
          displayMods.push("Cmd")
        }
      } else if (normalized === "Alt") {
        if (!modifiers.includes("Alt")) {
          modifiers.push("Alt")
          displayMods.push("Opt")
        }
      } else if (normalized === "Shift") {
        if (!modifiers.includes("Shift")) {
          modifiers.push("Shift")
          displayMods.push("Shift")
        }
      }
    } else {
      // Non-modifier key - use the last one pressed
      mainCode = code
    }
  }

  // Build display string
  const displayParts = [...displayMods]
  if (mainCode) {
    displayParts.push(codeToDisplayKey(mainCode))
  }
  const display = displayParts.join(" + ")

  // Build Tauri shortcut (only valid if we have at least one modifier AND a main key)
  let tauri: string | null = null
  if (modifiers.length > 0 && mainCode) {
    tauri = [...modifiers, codeToTauriKey(mainCode)].join("+")
  }

  return { display, tauri }
}

interface GlobalShortcutSectionProps {
  globalShortcut: GlobalShortcut
  onGlobalShortcutChange: (value: GlobalShortcut) => void
}

export function GlobalShortcutSection({
  globalShortcut,
  onGlobalShortcutChange,
}: GlobalShortcutSectionProps) {
  const isEnabled = globalShortcut !== null
  const defaultShortcut = "CommandOrControl+Shift+U"
  const [isRecording, setIsRecording] = useState(false)
  // Track pressed keys using event.code (physical key location)
  const pressedCodesRef = useRef<Set<string>>(new Set())
  const [pendingShortcut, setPendingShortcut] = useState<string | null>(null)
  const [pendingDisplay, setPendingDisplay] = useState<string>("")
  // Remember the last shortcut so we can restore it on re-enable
  const lastShortcutRef = useRef<string>(defaultShortcut)
  // Ref for the recording input to focus it properly
  const recordingRef = useRef<HTMLDivElement>(null)

  // Update last shortcut ref when shortcut changes
  useEffect(() => {
    if (globalShortcut) {
      lastShortcutRef.current = globalShortcut
    }
  }, [globalShortcut])

  // Focus the recording element after it mounts
  useEffect(() => {
    if (isRecording && recordingRef.current) {
      // Small delay to ensure DOM is ready
      const timer = setTimeout(() => {
        recordingRef.current?.focus()
      }, 10)
      return () => clearTimeout(timer)
    }
  }, [isRecording])

  const handleToggle = (checked: boolean) => {
    if (checked) {
      // Restore last used shortcut (or default if none)
      onGlobalShortcutChange(lastShortcutRef.current)
    } else {
      onGlobalShortcutChange(null)
      setIsRecording(false)
      pressedCodesRef.current = new Set()
      setPendingShortcut(null)
      setPendingDisplay("")
    }
  }

  const startRecording = () => {
    setIsRecording(true)
    pressedCodesRef.current = new Set()
    setPendingShortcut(null)
    setPendingDisplay("")
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    e.preventDefault()
    e.stopPropagation()

    // Escape cancels recording
    if (e.code === "Escape") {
      setIsRecording(false)
      pressedCodesRef.current = new Set()
      setPendingShortcut(null)
      setPendingDisplay("")
      return
    }

    // Add this key code to the set
    pressedCodesRef.current.add(e.code)

    // Build shortcut from all currently pressed keys
    const { display, tauri } = buildShortcutFromCodes(pressedCodesRef.current)
    setPendingDisplay(display)
    if (tauri) {
      setPendingShortcut(tauri)
    }
  }

  const handleKeyUp = (e: React.KeyboardEvent) => {
    e.preventDefault()
    e.stopPropagation()

    // Remove this key code from the ref (but don't update display - keep showing last combo)
    pressedCodesRef.current.delete(e.code)
  }

  const handleAccept = () => {
    if (pendingShortcut) {
      onGlobalShortcutChange(pendingShortcut)
    }
    setIsRecording(false)
    pressedCodesRef.current = new Set()
    setPendingShortcut(null)
    setPendingDisplay("")
  }

  const handleCancel = () => {
    setIsRecording(false)
    pressedCodesRef.current = new Set()
    setPendingShortcut(null)
    setPendingDisplay("")
  }

  // Display value logic
  const getDisplayValue = (): string => {
    if (isRecording) {
      if (pendingDisplay) return pendingDisplay
      return "Press keys..."
    }
    return globalShortcut ? formatShortcutForDisplay(globalShortcut) : ""
  }

  return (
    <section>
      <h3 className="text-lg font-semibold mb-0">Global Shortcut</h3>
      <p className="text-sm text-muted-foreground mb-2">
        Show panel from anywhere
      </p>
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm select-none">
          <Checkbox
            checked={isEnabled}
            onCheckedChange={(checked) => handleToggle(checked === true)}
          />
          Enable shortcut
        </label>
        {isEnabled && (
          <div className="space-y-2">
            {isRecording ? (
              <>
                <div
                  ref={recordingRef}
                  tabIndex={0}
                  role="textbox"
                  aria-label="Press keys to record shortcut"
                  onKeyDown={handleKeyDown}
                  onKeyUp={handleKeyUp}
                  className={cn(
                    "w-full h-8 px-3 text-sm rounded-md border-2 border-primary bg-muted/50",
                    "flex items-center outline-none",
                    !pendingDisplay && "text-muted-foreground"
                  )}
                >
                  {getDisplayValue()}
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    onClick={handleAccept}
                    disabled={!pendingShortcut}
                  >
                    Save
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={handleCancel}
                  >
                    Cancel
                  </Button>
                </div>
              </>
            ) : (
              <button
                type="button"
                onClick={startRecording}
                className={cn(
                  "w-full h-8 px-3 text-sm rounded-md border bg-muted/50",
                  "flex items-center text-left hover:bg-muted transition-colors"
                )}
              >
                <span>{getDisplayValue()}</span>
                <span className="ml-auto text-xs text-muted-foreground">Click to change</span>
              </button>
            )}
          </div>
        )}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Requires accessibility permission on macOS
      </p>
    </section>
  )
}
