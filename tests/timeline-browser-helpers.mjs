import assert from 'node:assert/strict';

export async function timelinePoint(page, seconds, lane) {
  return pointOnTimeline(page, seconds, { kind: 'lane', lane });
}

export async function touchTimelinePoint(page, seconds) {
  return pointOnTimeline(page, seconds, { kind: 'touch' });
}

async function pointOnTimeline(page, seconds, target) {
  const canvas = page.locator('.timeline-canvas');
  await page.waitForFunction(() => {
    const data = document.querySelector('.timeline-canvas')?.dataset;
    return data?.laneOrder && data.touchTrackCenter;
  });
  for (let attempt = 0; attempt < 10; attempt++) {
    const point = await canvas.evaluate((element, { seconds, target }) => {
      const data = element.dataset;
      const bounds = element.getBoundingClientRect();
      const scale = Number(data.pixelsPerSecond);
      let x;
      if (target.kind === 'touch') x = Number(data.touchTrackCenter);
      else {
        const order = data.laneOrder.split(',').map(Number);
        x = Number(data.gridLeft) + (order.indexOf(target.lane) + 0.5) * Number(data.laneWidth);
      }
      const y = Number(data.playheadY) - (seconds - Number(data.viewSeconds)) * scale;
      return { x: bounds.x + x, y: bounds.y + y, visible: y > 50 && y < bounds.height - 40,
        zoomX: bounds.x + bounds.width / 2, zoomY: bounds.y + bounds.height / 2, scale };
    }, { seconds, target });
    if (point.visible) return { x: point.x, y: point.y };
    await page.mouse.move(point.zoomX, point.zoomY);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, 400);
    await page.keyboard.up('Control');
    await page.waitForFunction((previous) => Number(document.querySelector('.timeline-canvas').dataset.pixelsPerSecond) !== previous, point.scale);
  }
  assert.fail(`Could not bring chart time ${seconds} into the timeline viewport`);
}

export async function clickTimeline(page, seconds, lane) {
  const point = await timelinePoint(page, seconds, lane);
  await page.mouse.click(point.x, point.y);
}

export async function clickTouchTimeline(page, seconds) {
  const point = await touchTimelinePoint(page, seconds);
  await page.mouse.click(point.x, point.y);
}
