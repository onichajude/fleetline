import { registerRootComponent } from "expo";

// Defines the background location task. It must load before anything else so the OS can
// wake the app with location updates even when no screen is mounted.
import "./src/tracking";

import App from "./App";

registerRootComponent(App);
