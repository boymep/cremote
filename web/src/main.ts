import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import { app } from './lib/state.svelte';
import { startViewportTracking } from './lib/viewport';
import { registerSW } from './lib/pwa';

const target = document.getElementById('app');
if (!target) throw new Error('#app not found');

startViewportTracking();
mount(App, { target });
void app.start();
registerSW();
