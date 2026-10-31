import { useState } from "react";
import { BookOpen } from "lucide-react";
import { Modal } from "./Modal.js";

export function Rules() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="match-action rules-button"
        aria-label="Read Dama rules"
        aria-haspopup="dialog"
        title="Read the Dama rules"
        onClick={() => setOpen(true)}
      >
        <BookOpen size={17} strokeWidth={1.8} aria-hidden="true" />
        <span>Rules</span>
      </button>

      <Modal open={open} title="Dama rules" onClose={() => setOpen(false)}>
        <div className="rules-content">
          <p className="rules-intro">
            Dama is played on an 8 × 8 board. Every square is in play, and White moves first.
          </p>

          <section className="rules-section" aria-labelledby="rules-men-heading">
            <h3 id="rules-men-heading">Men and kings</h3>
            <p>
              A man moves one empty square forward or sideways. It cannot move backward. Men capture
              forward or sideways, but not backward.
            </p>
            <p>
              A king slides any distance along a clear row or column. When it captures, it may land
              on any open square beyond the captured piece on that line. A king cannot immediately
              reverse direction by 180 degrees during a capture sequence.
            </p>
          </section>

          <section className="rules-section" aria-labelledby="rules-captures-heading">
            <h3 id="rules-captures-heading">Captures</h3>
            <p>
              If a capture is available, a quiet move is not allowed. Compare the complete capture
              sequences available to every piece: you must choose a sequence that captures the
              greatest number of pieces. If maximum sequences are tied, each is a legal choice.
            </p>
            <p>
              Finish the whole sequence before the turn changes. Captured pieces are removed as the
              sequence proceeds, so their squares are empty for later jumps in that same turn.
            </p>
          </section>

          <section className="rules-section" aria-labelledby="rules-promotion-heading">
            <h3 id="rules-promotion-heading">Promotion</h3>
            <p>
              A man becomes a king when its complete turn ends on the far edge of the board. If it
              reaches that edge partway through a capture sequence, it stays a man and finishes the
              sequence using man movement.
            </p>
          </section>

          <section className="rules-section" aria-labelledby="rules-endings-heading">
            <h3 id="rules-endings-heading">Wins and draws</h3>
            <p>
              You win when your opponent has no legal move, including when they have no pieces left.
              The game is automatically drawn if the same position with the same side to move occurs
              three times, or when each side has one piece remaining.
            </p>
            <p>
              This Dama setup does not use king-move or lone-king draw counters.
            </p>
          </section>

          <p className="rules-service-note">
            Online games use server-managed clocks and results. Disconnecting does not pause the
            active clock; a disconnected player has a limited recovery period to return.
          </p>
        </div>
      </Modal>
    </>
  );
}
