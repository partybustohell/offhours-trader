import { useRef, useState } from 'react';
import { postAction } from '../api';

interface Props {
  halted: boolean;
  onRefresh: () => void;
}

export default function ActionsBar({ halted, onRefresh }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function run(
    label: string,
    path: '/api/pipeline/run' | '/api/executor/tick' | '/api/halt' | '/api/resume',
    confirmText?: string,
  ) {
    if (busy) return;
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(label);
    setNote(null);
    const res = await postAction(path);
    setBusy(null);
    setNote({ ok: res.ok, text: res.ok ? `${label}: ok` : `${label}: ${res.message ?? 'failed'}` });
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(null), 8000);
    onRefresh();
  }

  return (
    <div className="actions">
      {note ? <span className={note.ok ? 'note-ok' : 'note-err'}>{note.text}</span> : null}
      <button
        className="btn"
        disabled={busy !== null}
        onClick={() => void run('Run pipeline', '/api/pipeline/run')}
      >
        Run pipeline
      </button>
      <button
        className="btn"
        disabled={busy !== null}
        onClick={() => void run('Tick', '/api/executor/tick')}
      >
        Tick now
      </button>
      {halted ? (
        <button
          className="btn"
          disabled={busy !== null}
          onClick={() => void run('Resume', '/api/resume')}
        >
          Resume
        </button>
      ) : (
        <button
          className="btn btn-danger"
          disabled={busy !== null}
          onClick={() =>
            void run('Halt', '/api/halt', 'Halt all trading? New entries stop until you resume.')
          }
        >
          Halt
        </button>
      )}
    </div>
  );
}
