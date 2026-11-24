package ai.facetype.capture

/**
 * The single point of contact between [FaceTypeCaptureModule] (a
 * `ReactContextBaseJavaModule`, created once per bridge) and whichever
 * [FaceTypePreviewView] is currently mounted in the RN view tree (created and
 * torn down per screen, e.g. every time `ScanScreen` mounts).
 *
 * The module never owns a `Session` itself (design review D1/D2, message
 * 2026-08-25T21-54-44Z_53356c299477): every ARCore/GL call has to run on the
 * view's own GL thread, so the module's job shrinks to "forward this
 * Promise-based call to the view that owns the camera right now". This
 * registry is that forwarding address. It intentionally holds at most one
 * view: FT-00's guided protocol never shows two camera previews at once.
 *
 * WHY THE FIELD IS PRIVATE (Codex M2 requirement G). It used to be a public
 * `@Volatile var` that attaching views wrote directly, with only the *clear*
 * side synchronised. A lock one writer does not take is not a lock: an
 * outgoing view's `clearIfCurrent(old)` could read `current` before an
 * incoming view's plain write of `new` became visible to it, then store
 * `null` over the new view -- leaving the module unable to reach the preview
 * actually on screen, with no error anywhere. Both transitions now happen
 * under the same monitor, so "is this still the current view?" and "make this
 * the current view" can no longer interleave.
 */
internal object FaceTypePreviewRegistry {
  private var current: FaceTypePreviewView? = null

  /** The view that is on screen right now, or `null`. */
  @Synchronized
  fun current(): FaceTypePreviewView? = current

  /** Makes [view] the current preview, replacing whatever was there. */
  @Synchronized
  fun attach(view: FaceTypePreviewView) {
    current = view
  }

  /**
   * Clears the registry only if it still points at [view]. Without this
   * compare-and-clear, a superseded view's own teardown (e.g. an old screen's
   * view finishing `release()` after a new screen's view has already
   * attached and registered itself) would erase the *new* view's registry
   * entry.
   */
  @Synchronized
  fun clearIfCurrent(view: FaceTypePreviewView) {
    if (current === view) current = null
  }
}
