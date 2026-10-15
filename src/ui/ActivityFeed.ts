import type { ActivityLog, FeedEntry } from "../manufacturing/eventFormat";
import { el } from "./dom";

export const FEED_SIZE = 20;

export class ActivityFeed {
  readonly element = el("section", "panel feed");
  private readonly list = el("ul", "feed-list");
  private renderedVersion = -1;

  private readonly log: ActivityLog;
  private readonly onSelect: (entry: FeedEntry) => void;

  constructor(log: ActivityLog, onSelect: (entry: FeedEntry) => void) {
    this.log = log;
    this.onSelect = onSelect;
    this.element.append(el("h2", undefined, "Manufacturing activity"), this.list);
  }

  /** Rebuilds at most FEED_SIZE rows, and only when the log changed. */
  update(): void {
    if (this.renderedVersion === this.log.version) return;
    this.renderedVersion = this.log.version;

    const rows = this.log.latest(FEED_SIZE).map((entry) => {
      const li = el("li", "feed-item");
      li.dataset.type = entry.type;
      const meta = el("div", "feed-meta");
      meta.append(
        el("span", "feed-time", `${entry.timestamp.slice(5, 10)} ${entry.timestamp.slice(11, 16)}`),
        el("span", "feed-type", entry.type.replace(/_/g, " ").toLowerCase()),
      );
      li.append(meta, el("div", "feed-text", entry.text));
      if (entry.where) li.append(el("div", "feed-where", entry.where));
      if (entry.objectIds.length) {
        li.classList.add("clickable");
        li.addEventListener("click", () => this.onSelect(entry));
      }
      return li;
    });

    if (rows.length === 0) {
      this.list.replaceChildren(el("li", "feed-empty", "No activity yet. Press Play."));
    } else {
      this.list.replaceChildren(...rows);
    }
  }
}
