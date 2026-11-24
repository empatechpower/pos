import { isTraining, setTraining } from "../training";

/**
 * A strip that flashes along the bottom of every screen (sign-in included) while the till is in practice mode. It floats over the screen and takes
 * no room from it; only its own button takes taps. Anyone can turn practice off from here; only a manager can turn it on.
 */
export function TrainingBanner() {
  if (!isTraining()) return null;
  return (
    <div className="training-banner" role="status">
      <b>TRAINING MODE</b>
      <span>Practice only · nothing here is recorded in the real system</span>
      <button onClick={() => setTraining(false)}>Turn off</button>
    </div>
  );
}
