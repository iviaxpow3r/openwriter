import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://openwriter.com',
  output: 'static',
  build: {
    assets: '_assets'
  }
});
