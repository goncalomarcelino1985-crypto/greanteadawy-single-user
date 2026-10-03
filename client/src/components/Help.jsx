import { Window } from './ui/Window.jsx';
import { SHORTCUTS } from '../lib/keyboard.js';
import { useStore } from '../state/store.js';

export function Help() {
  const st = useStore.getState();
  const openApi = () => { useStore.setState({ settingsTab: 'api' }); st.openWindow('settings'); };
  return (
    <Window name="help" title="Help — shortcuts & Claude" icon="keyboard" minW={420} minH={300}>
      <div className="help">
        <h3>Make music with Claude (MCP)</h3>
        <p>GreanTeaDawy exposes an MCP server with 70+ tools so Claude can create channels, write drums, chords and melodies,
          use your uploaded and recorded samples (it sees their bitrate, sample rate, loudness, tempo, key and pitch, files
          them in folders and can edit or auto-tune them), arrange the song, mix, render and analyse the mixdown, save
          versions and press play — all live in this window.</p>
        <p><button className="btn primary" onClick={openApi}>Open Settings → API & MCP</button> for copy-paste setup for Claude Code and Claude Desktop, and to create your personal API token.</p>
        <p>Try: <i>“Make a lo-fi beat at 80 BPM with jazzy chords, mix it to -14 LUFS, then play it.”</i></p>
        <h3>Keyboard shortcuts</h3>
        <table className="shortcuts">
          <tbody>
            {SHORTCUTS.map(([k, d]) => <tr key={k}><td><kbd>{k}</kbd></td><td>{d}</td></tr>)}
          </tbody>
        </table>
      </div>
    </Window>
  );
}
