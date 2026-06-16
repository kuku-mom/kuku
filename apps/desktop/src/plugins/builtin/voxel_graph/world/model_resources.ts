import { disposeHouseModels } from "./buildings_model";
import { disposeCharacterModels } from "./character_model";
import { disposeToonGradient } from "./toon";

let retainCount = 0;

export function retainWorldModelResources(): () => void {
  retainCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    retainCount = Math.max(0, retainCount - 1);
    if (retainCount > 0) return;
    disposeCharacterModels();
    disposeHouseModels();
    disposeToonGradient();
  };
}
