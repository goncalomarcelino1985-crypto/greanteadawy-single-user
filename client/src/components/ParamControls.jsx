import { Knob } from './ui/Knob.jsx';
import { Select } from './ui/Controls.jsx';
import { Icon } from './ui/Icon.jsx';

/**
 * Renders knobs/selects/toggles for a list of param definitions, grouped by def.group.
 * onChange(key, value)
 */
export function ParamControls({ defs, values, onChange, color, samples, onSamplePick, onSampleEdit, channels, compact = false }) {
  const groups = [];
  const byGroup = new Map();
  for (const d of defs) {
    const g = d.group || '';
    if (!byGroup.has(g)) { byGroup.set(g, []); groups.push(g); }
    byGroup.get(g).push(d);
  }
  return (
    <div className={`params ${compact ? 'compact' : ''}`}>
      {groups.map((g) => (
        <fieldset key={g || 'main'} className="param-group">
          {g && <legend>{g}</legend>}
          <div className="param-row">
            {byGroup.get(g).map((d) => <Param key={d.key} def={d} value={values[d.key]} onChange={onChange} color={color} samples={samples} onSamplePick={onSamplePick} onSampleEdit={onSampleEdit} channels={channels} />)}
          </div>
        </fieldset>
      ))}
    </div>
  );
}

function Param({ def, value, onChange, color, samples, onSamplePick, onSampleEdit, channels }) {
  if (def.type === 'number') {
    return (
      <Knob value={value ?? def.default} min={def.min} max={def.max} def={def.default} curve={def.curve} step={def.step}
        label={def.label} unit={def.unit} color={color} showValue size={34} bipolar={def.min < 0 && def.max > 0}
        onChange={(v) => onChange(def.key, v)} />
    );
  }
  if (def.type === 'select') {
    return (
      <label className="param-select">
        <Select value={value ?? def.default} options={def.options} onChange={(v) => onChange(def.key, v)} />
        <span>{def.label}</span>
      </label>
    );
  }
  if (def.type === 'bool') {
    return (
      <label className="param-bool">
        <button className={`toggle ${value ? 'on' : ''}`} onClick={() => onChange(def.key, !value)} aria-pressed={!!value}>{value ? 'ON' : 'OFF'}</button>
        <span>{def.label}</span>
      </label>
    );
  }
  if (def.type === 'channel') {
    const missing = value && !(channels || []).some((c) => c.id === value);
    return (
      <label className="param-select" title={def.description}>
        <Select value={value || ''} onChange={(v) => onChange(def.key, v || null)}
          options={[{ value: '', label: '— none —' }, ...(channels || []).map((c) => ({ value: c.id, label: c.name })), ...(missing ? [{ value, label: '(deleted channel)' }] : [])]} />
        <span>{def.label}</span>
      </label>
    );
  }
  if (def.type === 'sample') {
    return (
      <label className="param-sample">
        <Select value={value || ''} options={[{ value: '', label: '— choose sample —' }, ...(samples || []).map((s) => ({ value: s.id, label: s.name, group: s.group }))]}
          onChange={(v) => onChange(def.key, v || null)} />
        {onSamplePick && <button className="btn tiny" onClick={onSamplePick} title="Upload a sample" aria-label="Upload a sample"><Icon name="upload" size={12} /></button>}
        {onSampleEdit && value && <button className="btn tiny" onClick={() => onSampleEdit(value)} title="Edit this sample in the wave editor" aria-label="Edit sample"><Icon name="edit" size={12} /></button>}
        <span>{def.label}</span>
      </label>
    );
  }
  return null;
}
