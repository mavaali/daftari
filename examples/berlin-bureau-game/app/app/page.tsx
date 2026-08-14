"use client";

import { useEffect, useRef, useState } from "react";

type Msg = { role: "user" | "assistant"; content: string };

export default function Page() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [messages]);

  async function send(text: string) {
    if (!text.trim() || busy) return;
    const next: Msg[] = [...messages, { role: "user", content: text }];
    setMessages([...next, { role: "assistant", content: "" }]);
    setInput("");
    setBusy(true);
    try {
      const res = await fetch("/api/gm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next }),
      });
      if (!res.ok || !res.body) {
        const err = await res.text().catch(() => "");
        setMessages((m) => {
          const copy = [...m];
          copy[copy.length - 1] = { role: "assistant", content: `[transmission error] ${err}` };
          return copy;
        });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        setMessages((m) => {
          const copy = [...m];
          copy[copy.length - 1] = { role: "assistant", content: acc };
          return copy;
        });
      }
    } catch (e) {
      setMessages((m) => {
        const copy = [...m];
        copy[copy.length - 1] = { role: "assistant", content: `[transmission error] ${String(e)}` };
        return copy;
      });
    } finally {
      setBusy(false);
    }
  }

  function begin() {
    setStarted(true);
    send("Analyst reporting for duty. Brief me.");
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  }

  return (
    <div className="app">
      <header className="masthead">
        <div className="kicker">Berlin Bureau · Case 1</div>
        <h1>The Hollow King</h1>
        <div className="sub">A mole hunt. Grade your sources. Corroborate before you name.</div>
      </header>

      <div className="thread" ref={threadRef}>
        {!started && (
          <div className="start">
            <p>
              A penetration has bled the Directorate. The Station Chief has frozen an exfiltration and
              handed you the file. The loud suspect is a trap — the truth is only reachable if you
              grade every source, corroborate against independent records, and hold the contradictions
              open. Careless analysts get burned.
            </p>
            <button className="cta" onClick={begin}>
              Report for duty
            </button>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role === "user" ? "you" : "gm"}`}>
            <div className="who">{m.role === "user" ? "You" : "Station"}</div>
            <div className="body">
              {m.content}
              {busy && i === messages.length - 1 && m.role === "assistant" && (
                <span className="cursor">&nbsp;</span>
              )}
            </div>
          </div>
        ))}
      </div>

      {started && (
        <div className="composer">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            placeholder="Investigate — e.g. 'list the field reports', 'read fr-018', 'search cartographer'…"
            disabled={busy}
          />
          <button onClick={() => send(input)} disabled={busy || !input.trim()}>
            Send
          </button>
        </div>
      )}

      <footer className="foot">
        A playable demo of <a href="https://github.com/mavaali/daftari">daftari</a> discipline — grade
        sources, corroborate, hold tensions open.
      </footer>
    </div>
  );
}
