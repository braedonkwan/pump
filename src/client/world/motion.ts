// Own a short sequence and its temporary nodes so cancellation always cleans up.
export class MotionGroup {
  private readonly animations = new Set<Animation>();
  private readonly nodes = new Set<Element>();

  play(
    target: Element,
    frames: Keyframe[],
    options: KeyframeAnimationOptions,
  ): Animation {
    const animation = target.animate(frames, options);
    this.animations.add(animation);
    const remove = () => this.animations.delete(animation);
    void animation.finished.then(remove, remove);
    if (document.hidden) animation.pause();
    return animation;
  }

  own<T extends Element>(node: T): T {
    this.nodes.add(node);
    return node;
  }

  particle(
    node: Element,
    frames: Keyframe[],
    options: KeyframeAnimationOptions,
  ): void {
    this.own(node);
    const remove = () => {
      this.nodes.delete(node);
      node.remove();
    };
    void this.play(node, frames, options).finished.then(remove, remove);
  }

  async finished(): Promise<void> {
    await Promise.allSettled(
      [...this.animations].map((animation) => animation.finished),
    );
  }

  pause(hidden: boolean): void {
    for (const animation of this.animations) {
      if (hidden) animation.pause();
      else if (animation.playState === 'paused') animation.play();
    }
  }

  clear(): void {
    for (const animation of this.animations) animation.cancel();
    this.animations.clear();
    for (const node of this.nodes) node.remove();
    this.nodes.clear();
  }
}
