// Pure state transitions: only consecutive, fresh model evidence completes a step.
export class CheckpointGate {
  constructor({ threshold = .85, confirmations = 2, maxGapMs = 8000 } = {}) {
    this.threshold = threshold;
    this.confirmations = confirmations;
    this.maxGapMs = maxGapMs;
    this.reset();
  }
  reset() { this.streak = 0; this.lastAt = 0; this.complete = false; }
  observe(result, at) {
    if (this.complete) return { complete: true, streak: this.streak };
    if (this.lastAt && at - this.lastAt > this.maxGapMs) this.streak = 0;
    const positive = result.state === 'placed' && result.placedProbability >= this.threshold && result.targetVisible >= this.threshold;
    this.streak = positive ? this.streak + 1 : 0;
    this.lastAt = at;
    this.complete = this.streak >= this.confirmations;
    return { complete: this.complete, streak: this.streak };
  }
}

export function bodyOnly(result) {
  const keep = points => points?.map(p => ({ x: p.x, y: p.y, z: p.z, visibility: p.visibility })) ?? [];
  // HandLandmarker doesn't estimate visibility. Its protobuf default can be 0;
  // treating that as a body visibility score would hide every finger overlay.
  const keepHand = points => points?.map(p => ({ x: p.x, y: p.y, z: p.z })) ?? [];
  return {
    // MediaPipe Pose includes coarse head points. Discard them at the worker boundary.
    body: (result.pose?.landmarks ?? []).map(points => keep(points.slice(11))),
    bodyWorld: (result.pose?.worldLandmarks ?? []).map(points => keep(points.slice(11))),
    hands: (result.hands?.landmarks ?? []).map(keepHand),
    handsWorld: (result.hands?.worldLandmarks ?? []).map(keepHand),
    handedness: (result.hands?.handedness ?? []).map(categories => ({ label: categories[0]?.categoryName ?? 'Unknown', score: categories[0]?.score ?? 0 })),
  };
}
