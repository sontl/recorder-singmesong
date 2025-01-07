import puppeteer from 'puppeteer';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { homedir } from 'os';

declare global {
  interface Window {
    startRecording: () => void;
    isSketchReady: () => boolean;
    isRecordingFinished: () => boolean;
    getRecordedVideo: () => Blob;
  }
}

const app = express();
app.use(express.json());

interface VideoRequest {
  songUrl: string;
  outputPath?: string;
  compress?: boolean;
}

async function generateVideo(req: VideoRequest): Promise<string> {
  process.env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD = 'true';
  
  // Get Chrome executable path based on platform
  const executablePath = process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/usr/bin/google-chrome';  // Ubuntu/Linux path
    
  const browser = await puppeteer.launch({
    executablePath,
    headless: 'new',
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--no-first-run',
      '--disable-crash-reporter',
      '--disable-extensions',
      '--disable-component-extensions-with-background-pages',
      '--disable-features=ChromeBrowserCloudManagement',
      '--disable-site-isolation-trials',
      '--disable-web-security',
    ],
    dumpio: true,
    ignoreDefaultArgs: ['--enable-automation'],
    pipe: true,
    timeout: 120000
  });

  let isBrowserClosed = false;
  browser.on('disconnected', () => {
    console.log('Browser disconnected event triggered');
    isBrowserClosed = true;
  });

  const page = await browser.newPage();
  
  try {
    page.setDefaultNavigationTimeout(120000);
    
    page.on('console', msg => console.log('Browser console:', msg.type(), msg.text()));
    page.on('pageerror', err => console.error('Page error:', err));
    page.on('error', err => console.error('Error:', err));
    
    browser.on('disconnected', () => {
      console.error('Browser disconnected unexpectedly');
    });

    console.log(`Navigating to: https://dev.singmesong.com/visualizer/${req.songUrl}`);
    await page.goto(`https://dev.singmesong.com/visualizer/${req.songUrl}`, {
      waitUntil: 'networkidle0',
      timeout: 60000
    });

    console.log('Page loaded, checking window properties...');

    const windowProps = await page.evaluate(() => {
      return {
        hasStartRecording: typeof window.startRecording === 'function',
        hasIsSketchReady: typeof window.isSketchReady === 'function',
        hasIsRecordingFinished: typeof window.isRecordingFinished === 'function',
        hasGetRecordedVideo: typeof window.getRecordedVideo === 'function',
        windowKeys: Object.keys(window)
      };
    });
    
    console.log('Window properties:', windowProps);

    console.log('Waiting for sketch to be ready...');
    
    console.log('Sketch is ready, starting recording...');

  
    const recordingTimeout = 600000;
    const startTime = Date.now();
    
    while (Date.now() - startTime < recordingTimeout) {
      const isFinished = await page.evaluate(() => window.isRecordingFinished?.());
      if (isFinished) {
        console.log('Recording finished, retrieving video data...');
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (Date.now() - startTime >= recordingTimeout) {
      throw new Error('Recording timeout exceeded');
    }

    const videoBuffer = await page.evaluate(`
      (async () => {
        console.log('Getting recorded video...');
        const blob = window.getRecordedVideo();
        if (!blob) {
          throw new Error('No video data available');
        }
        console.log('Video blob size:', blob.size);
        return Array.from(new Uint8Array(await blob.arrayBuffer()));
      })()
    `);

    // Add a small delay after getting the video data
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Create the output directory if it doesn't exist
    const outputDir = path.join(homedir(), 'recordings');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const outputPath = req.outputPath 
      ? path.join(homedir(), req.outputPath.replace('~', ''))
      : path.join(outputDir, `output-${Date.now()}.mp4`);

    // Write the file first
    console.log('Writing video to file:', outputPath);
    fs.writeFileSync(outputPath, Buffer.from(new Uint8Array(videoBuffer as number[])));

    // Add another small delay before closing
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Graceful shutdown with more detailed logging
    if (!isBrowserClosed) {
      console.log('Starting graceful browser shutdown...');
      try {
        await page.close().catch(e => console.warn('Error closing page:', e));
        console.log('Page closed successfully');
        await browser.close().catch(e => console.warn('Error closing browser:', e));
        console.log('Browser closed successfully');
      } catch (e) {
        console.warn('Error during graceful shutdown:', e);
      }
    }

    return outputPath;
  } catch (error) {
    console.error('Error during video generation:', error);
    await page.screenshot({ path: 'error-screenshot.png' }).catch(e => console.warn('Error taking screenshot:', e));
    throw error;
  } finally {
    // Only try to close if not already closed
    if (!isBrowserClosed) {
      try {
        await page.close().catch(() => {});
        await browser.close().catch(() => {});
      } catch (closeError) {
        console.warn('Error during cleanup:', closeError);
      }
    }
  }
}

// API endpoint
app.post('/generate-video', async (req, res) => {
  try {
    const { songUrl, outputPath, compress = true } = req.body;
    const videoPath = await generateVideo({ songUrl, outputPath, compress });
    res.json({ success: true, outputPath: videoPath });
  } catch (error: unknown) {
    console.error('Error generating video:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    res.status(500).json({ success: false, error: errorMessage });
  }
});

// Start server
const PORT = process.env.PORT || 3003;
app.listen(PORT, () => {
  console.log(`Video generator service running on port ${PORT}`);
});