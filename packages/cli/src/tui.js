/**
 * typeheard tui: your transcripts, and a box to drop a path into.
 *
 * Type or paste a path and press Enter to upload it; Up/Down picks a transcript
 * from the list and its text shows underneath. Ctrl+C quits.
 */
import { createApp } from '@profullstack/hqtui';
import { list, text, transcribe } from './client.js';

export async function runTui(auth) {
  const state = {
    draft: '',
    rows: [],
    selected: 0,
    preview: [],
    status: auth.key
      ? 'Loading your transcripts…'
      : 'Not signed in: uploads get the free preview. Run typeheard login for whole files.',
    busy: false,
  };
  const app = await createApp({ fps: 20, quitKeys: [] });

  const refresh = async () => {
    if (!auth.key) return;
    try {
      state.rows = (await list(auth)).transcripts;
      if (state.status.startsWith('Loading')) state.status = `${state.rows.length} transcripts`;
      await show();
    } catch (err) {
      state.status = err.message;
    }
    app.invalidate();
  };

  const show = async () => {
    const row = state.rows[state.selected];
    state.preview = [];
    if (row?.status === 'done') {
      const body = await text(auth, row.id, 'txt').catch((err) => err.message);
      state.preview = String(body).split('\n');
    } else if (row) state.preview = [`${row.status}${row.error ? `: ${row.error}` : ''}`];
    app.invalidate();
  };

  const upload = async () => {
    const path = state.draft.trim().replace(/^['"]|['"]$/g, '');
    if (!path || state.busy) return;
    state.busy = true;
    state.status = `Uploading ${path}…`;
    app.invalidate();
    try {
      const { job, output } = await transcribe(auth, {
        path,
        onStatus: (j) => {
          state.status = `${j.status}${j.queue_position ? `, ${j.queue_position} ahead` : ''}  ${j.url ?? ''}`;
          app.invalidate();
        },
      });
      state.status = `Done: ${job.url}`;
      state.preview = output.split('\n');
      state.draft = '';
      await refresh();
    } catch (err) {
      state.status = err.message;
    }
    state.busy = false;
    app.invalidate();
  };

  app.on('key', (event) => {
    if (event.key === 'ctrl+c') return app.quit();
    if (event.name === 'enter') return void upload();
    if (event.name === 'up' || event.name === 'down') {
      if (!state.rows.length) return;
      state.selected =
        (state.selected + (event.name === 'up' ? -1 : 1) + state.rows.length) % state.rows.length;
      return void show();
    }
    if (event.name === 'backspace') state.draft = state.draft.slice(0, -1);
    else if (event.name === 'escape') state.draft = '';
    else if (event.char && !event.ctrl && !event.alt) state.draft += event.char;
    app.invalidate();
  });

  app.render(({ ui, theme, height }) => {
    ui.column({ gap: 1 }, (root) => {
      root.panel({ title: 'typeheard' }, (panel) => {
        panel.text(
          'Type or paste a path to an audio or video file, then Enter. Up/Down picks a transcript.',
          { fg: theme.muted },
        );
        panel.text(`> ${state.draft}${state.busy ? '' : '█'}`, { fg: theme.accent });
        panel.text(state.status, { fg: theme.muted });
      });
      if (state.rows.length) {
        root.panel({ title: 'Transcripts' }, (panel) => {
          state.rows.slice(0, 8).forEach((row, i) => {
            const mark = i === state.selected ? '›' : ' ';
            panel.text(
              `${mark} ${row.status.padEnd(7)} ${String(Math.round(row.duration_sec / 60)).padStart(3)}m  ${row.title ?? row.filename ?? row.id}`,
              {
                fg: i === state.selected ? theme.accent : undefined,
              },
            );
          });
        });
      }
      if (state.preview.length) {
        root.panel({ title: 'Text' }, (panel) => {
          for (const line of state.preview.slice(0, Math.max(4, height - 22))) panel.text(line);
        });
      }
    });
  });

  void refresh();
  await app.start();
}
