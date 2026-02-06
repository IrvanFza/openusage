import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import {
  AUTO_UPDATE_OPTIONS,
  DISPLAY_MODE_OPTIONS,
  TRAY_ICON_STYLE_OPTIONS,
  THEME_OPTIONS,
  type AutoUpdateIntervalMinutes,
  type DisplayMode,
  type ThemeMode,
  type TrayIconStyle,
} from "@/lib/settings";
import { cn } from "@/lib/utils";

interface PluginConfig {
  id: string;
  name: string;
  enabled: boolean;
}

const PREVIEW_BAR_TRACK_PX = 20;
const PREVIEW_MIN_REMAINDER_PX = 2;
const PREVIEW_EDGE_DIVIDER_PX = 2;

function getPreviewBarLayout(fraction: number): { fillPercent: number; showDivider: boolean } {
  const clamped = Math.max(0, Math.min(1, fraction));
  if (clamped <= 0) return { fillPercent: 0, showDivider: false };
  if (clamped >= 1) return { fillPercent: 100, showDivider: false };

  const minFillW = 1;
  const maxFillW = Math.max(minFillW, PREVIEW_BAR_TRACK_PX - PREVIEW_MIN_REMAINDER_PX);
  const fillW = Math.max(minFillW, Math.min(maxFillW, Math.round(PREVIEW_BAR_TRACK_PX * clamped)));
  return {
    fillPercent: (fillW / PREVIEW_BAR_TRACK_PX) * 100,
    showDivider: fillW > 0 && fillW < PREVIEW_BAR_TRACK_PX,
  };
}

function TrayIconStylePreview({
  style,
  isActive,
  showPercentage,
}: {
  style: TrayIconStyle;
  isActive: boolean;
  showPercentage: boolean;
}) {
  const trackClass = isActive ? "bg-white/35" : "bg-black/20";
  const fillClass = isActive ? "bg-white" : "bg-black";
  const textClass = isActive ? "text-white" : "text-foreground";

  if (style === "bars") {
    const fractions = [0.83, 0.7, 0.56];
    return (
      <div className="flex items-center gap-1">
        <div className="flex flex-col gap-0.5 w-5">
          {fractions.map((fraction, i) => {
            const { fillPercent, showDivider } = getPreviewBarLayout(fraction);
            return (
              <div key={i} className={`relative h-1 rounded-sm ${trackClass}`}>
                <div
                  className={`h-1 ${fillClass}`}
                  style={{ width: `${fillPercent}%`, borderRadius: "2px 1px 1px 2px" }}
                />
                {showDivider && (
                  <span
                    aria-hidden
                    className={fillClass}
                    style={{
                      position: "absolute",
                      left: `calc(${fillPercent}% - ${PREVIEW_EDGE_DIVIDER_PX / 2}px)`,
                      top: 0,
                      bottom: 0,
                      width: PREVIEW_EDGE_DIVIDER_PX,
                      opacity: 0.5,
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
        {showPercentage && (
          <span className={`text-[13px] font-bold tabular-nums leading-none ${textClass}`}>
            83%
          </span>
        )}
      </div>
    );
  }

  if (style === "circle") {
    return (
      <div className="flex items-center gap-1">
        <svg width="11" height="11" viewBox="0 0 26 26" aria-hidden className="shrink-0">
          <circle
            cx="13"
            cy="13"
            r="9"
            fill="none"
            stroke="currentColor"
            strokeWidth="4"
            opacity={isActive ? 0.35 : 0.2}
            className={textClass}
          />
          <circle
            cx="13"
            cy="13"
            r="9"
            fill="none"
            stroke="currentColor"
            strokeWidth="4"
            strokeLinecap="butt"
            pathLength="100"
            strokeDasharray="83 100"
            transform="rotate(-90 13 13)"
            className={textClass}
          />
        </svg>
        {showPercentage && (
          <span className={`text-[13px] font-bold tabular-nums leading-none ${textClass}`}>
            83%
          </span>
        )}
      </div>
    );
  }

  return (
    <span className={cn("text-[13px] font-bold tabular-nums leading-none", textClass)}>
      83%
    </span>
  );
}

function SortablePluginItem({
  plugin,
  onToggle,
}: {
  plugin: PluginConfig;
  onToggle: (id: string) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: plugin.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "flex items-center gap-3 px-3 py-2 rounded-md bg-card",
        "border border-transparent",
        isDragging && "opacity-50 border-border"
      )}
    >
      <button
        type="button"
        className="touch-none cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground transition-colors"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-4 w-4" />
      </button>

      <span
        className={cn(
          "flex-1 text-sm",
          !plugin.enabled && "text-muted-foreground"
        )}
      >
        {plugin.name}
      </span>

      <Checkbox
        key={`${plugin.id}-${plugin.enabled}`}
        checked={plugin.enabled}
        onCheckedChange={() => onToggle(plugin.id)}
      />
    </div>
  );
}

interface SettingsPageProps {
  plugins: PluginConfig[];
  onReorder: (orderedIds: string[]) => void;
  onToggle: (id: string) => void;
  autoUpdateInterval: AutoUpdateIntervalMinutes;
  onAutoUpdateIntervalChange: (value: AutoUpdateIntervalMinutes) => void;
  themeMode: ThemeMode;
  onThemeModeChange: (value: ThemeMode) => void;
  displayMode: DisplayMode;
  onDisplayModeChange: (value: DisplayMode) => void;
  trayIconStyle: TrayIconStyle;
  onTrayIconStyleChange: (value: TrayIconStyle) => void;
  trayShowPercentage: boolean;
  onTrayShowPercentageChange: (value: boolean) => void;
}

export function SettingsPage({
  plugins,
  onReorder,
  onToggle,
  autoUpdateInterval,
  onAutoUpdateIntervalChange,
  themeMode,
  onThemeModeChange,
  displayMode,
  onDisplayModeChange,
  trayIconStyle,
  onTrayIconStyleChange,
  trayShowPercentage,
  onTrayShowPercentageChange,
}: SettingsPageProps) {
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      const oldIndex = plugins.findIndex((item) => item.id === active.id);
      const newIndex = plugins.findIndex((item) => item.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;
      const next = arrayMove(plugins, oldIndex, newIndex);
      onReorder(next.map((item) => item.id));
    }
  };

  return (
    <div className="py-3 space-y-4">
      <section>
        <h3 className="text-lg font-semibold mb-1">Appearance</h3>
        <p className="text-sm text-foreground mb-2">
          Choose your color theme
        </p>
        <div className="bg-muted/50 rounded-lg p-1">
          <div className="flex gap-1" role="radiogroup" aria-label="Theme mode">
            {THEME_OPTIONS.map((option) => {
              const isActive = option.value === themeMode;
              return (
                <Button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={isActive}
                  variant={isActive ? "default" : "outline"}
                  size="sm"
                  className="flex-1"
                  onClick={() => onThemeModeChange(option.value)}
                >
                  {option.label}
                </Button>
              );
            })}
          </div>
        </div>
      </section>
      <section>
        <h3 className="text-lg font-semibold mb-1">Show Usage As</h3>
        <p className="text-sm text-foreground mb-2">
          Show how much was used or is left
        </p>
        <div className="bg-muted/50 rounded-lg p-1">
          <div className="flex gap-1" role="radiogroup" aria-label="Usage display mode">
            {DISPLAY_MODE_OPTIONS.map((option) => {
              const isActive = option.value === displayMode;
              return (
                <Button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={isActive}
                  variant={isActive ? "default" : "outline"}
                  size="sm"
                  className="flex-1"
                  onClick={() => onDisplayModeChange(option.value)}
                >
                  {option.label}
                </Button>
              );
            })}
          </div>
        </div>
      </section>
      <section>
        <h3 className="text-lg font-semibold mb-1">Menu Bar Icon</h3>
        <p className="text-sm text-foreground mb-2">
          Choose how usage appears in the menu bar icon.
        </p>
        <div className="bg-muted/50 rounded-lg p-1">
          <div className="flex gap-1" role="radiogroup" aria-label="Tray icon style">
            {TRAY_ICON_STYLE_OPTIONS.map((option) => {
              const isActive = option.value === trayIconStyle;
              const showPreviewPercent =
                option.value !== "textOnly" && trayShowPercentage;
              return (
                <Button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-label={option.label}
                  aria-checked={isActive}
                  variant={isActive ? "default" : "outline"}
                  size="sm"
                  className="flex-1"
                  onClick={() => onTrayIconStyleChange(option.value)}
                >
                  <TrayIconStylePreview
                    style={option.value}
                    isActive={isActive}
                    showPercentage={showPreviewPercent}
                  />
                </Button>
              );
            })}
          </div>
        </div>
        {trayIconStyle !== "textOnly" && (
          <label className="mt-2 inline-flex items-center gap-2 text-sm text-foreground">
            <Checkbox
              key={`tray-show-percentage-${trayShowPercentage}`}
              checked={trayShowPercentage}
              onCheckedChange={(checked) => onTrayShowPercentageChange(checked === true)}
            />
            <span>Show percentage</span>
          </label>
        )}
      </section>
      <section>
        <h3 className="text-lg font-semibold mb-1">Auto Update</h3>
        <p className="text-sm text-foreground mb-2">
          How often we update your usage
        </p>
        <div className="bg-muted/50 rounded-lg p-1">
          <div className="flex gap-1" role="radiogroup" aria-label="Auto-update interval">
            {AUTO_UPDATE_OPTIONS.map((option) => {
              const isActive = option.value === autoUpdateInterval;
              return (
                <Button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={isActive}
                  variant={isActive ? "default" : "outline"}
                  size="sm"
                  className="flex-1"
                  onClick={() => onAutoUpdateIntervalChange(option.value)}
                >
                  {option.label}
                </Button>
              );
            })}
          </div>
        </div>
      </section>
      <section>
        <h3 className="text-lg font-semibold mb-1">Plugins</h3>
        <p className="text-sm text-foreground mb-2">
          Manage and reorder sources
        </p>
        <div className="bg-muted/50 rounded-lg p-1 space-y-1">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={plugins.map((p) => p.id)}
              strategy={verticalListSortingStrategy}
            >
              {plugins.map((plugin) => (
                <SortablePluginItem
                  key={plugin.id}
                  plugin={plugin}
                  onToggle={onToggle}
                />
              ))}
            </SortableContext>
          </DndContext>
        </div>
      </section>
    </div>
  );
}
