import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://openwriter.io',
  output: 'static',
  build: {
    assets: '_assets'
  }
});
