"use client";

import { useState } from "react";
import { cn } from "@/lib/format";

/** Read / bookmark / copy controls for the article detail page. */
export function ArticleActions({
  articleId,
  url,
  initialRead,
  initialBookmarked,
}: {
  articleId: string;
  url: string;
  initialRead: boolean;
  initialBookmarked: boolean;
}) {
  const [read, setRead] = useState(initialRead);
  const [bookmarked, setBookmarked] = useState(initialBookmarked);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function patch(next: { read?: boolean; bookmarked?: boolean }) {
    try {
      const response = await fetch(`/api/updates/${articleId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!response.ok) throw new Error(`save failed (${response.status})`);
      setError(null);
    } catch (patchError) {
      setError(patchError instanceof Error ? patchError.message : "save failed");
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <a href={url} target="_blank" rel="noreferrer noopener" className="btn btn-primary">
        Open original article ↗
      </a>
      <button
        type="button"
        className={cn("btn", bookmarked && "border-amber-400/50 text-amber-200")}
        onClick={() => {
          const next = !bookmarked;
          setBookmarked(next);
          void patch({ bookmarked: next });
        }}
      >
        {bookmarked ? "★ Bookmarked" : "☆ Bookmark"}
      </button>
      <button
        type="button"
        className="btn"
        onClick={() => {
          const next = !read;
          setRead(next);
          void patch({ read: next });
        }}
      >
        {read ? "Mark unread" : "Mark read"}
      </button>
      <button
        type="button"
        className="btn"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1600);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? "Link copied" : "Copy link"}
      </button>
      {error ? <span className="text-xs text-rose-300">{error}</span> : null}
    </div>
  );
}
