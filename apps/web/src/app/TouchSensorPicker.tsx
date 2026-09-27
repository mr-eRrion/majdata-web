import type { MouseEvent } from 'react';
import type { Note } from '../../../../packages/chart-core/src/types.js';
import { touchPositions } from '../skin/composition.js';

type Area = NonNullable<Note['touchArea']>;
const sensors = Object.entries(touchPositions);

export function TouchSensorPicker({ area, position, occupied, disabled, onChoose }: {
  area: Area;
  position: number;
  occupied: string[];
  disabled: boolean;
  onChoose: (area: Area, position: number) => void;
}) {
  const selected = area === 'C' ? 'C' : `${area}${position}`;
  const choose = (name: string) => {
    if (!disabled) onChoose(name[0] as Area, name === 'C' ? 0 : Number(name[1]));
  };
  const chooseNearest = (event: MouseEvent<SVGSVGElement>) => {
    if (disabled) return;
    const svg = event.currentTarget;
    const point = svg.createSVGPoint();
    point.x = event.clientX; point.y = event.clientY;
    const local = point.matrixTransform(svg.getScreenCTM()!.inverse());
    if (Math.hypot(local.x, local.y) > 5) return;
    let closest = sensors[0];
    let distance = Infinity;
    for (const sensor of sensors) {
      const delta = Math.hypot(local.x - sensor[1][0], local.y + sensor[1][1]);
      if (delta < distance) { closest = sensor; distance = delta; }
    }
    choose(closest[0]);
  };
  return <svg className="touch-sensor-picker" viewBox="-5 -5 10 10" role="group"
    aria-label="Touch 传感器选择" aria-disabled={disabled} onClick={chooseNearest}>
    <circle r="4.8" className="sensor-board" />
    {sensors.map(([name, [x, y]]) => <g key={name} role="button" tabIndex={disabled ? -1 : 0}
      aria-label={`选择传感器 ${name}`} aria-disabled={disabled} aria-pressed={selected === name}
      data-sensor={name} className={`${selected === name ? 'selected' : ''} ${occupied.includes(name) ? 'occupied' : ''}`}
      transform={`translate(${x} ${-y})`} onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(name); }
      }}>
      <circle r="0.34" />
      <text textAnchor="middle" dominantBaseline="central">{name}</text>
    </g>)}
  </svg>;
}
