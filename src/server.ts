import { createApp } from './app.js';
import { config } from './config.js';

createApp().listen(config.port, () => console.log(`API + UI on http://localhost:${config.port}`));
