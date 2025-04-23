const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error('[UNHANDLED REJECTION]', err);
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const ytDlpPath = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';

const calculateAspectRatio = (width, height) => {
  if (!width || !height) return 'N/A';
  const gcd = (a, b) => b ? gcd(b, a % b) : a;
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
};

const getQualityLabel = (height) => {
  if (!height) return 'Unknown';
  if (height >= 2160) return '2160p (4K)';
  if (height >= 1440) return '1440p (2K)';
  if (height >= 1080) return '1080p (HD)';
  if (height >= 720) return '720p (HD)';
  if (height >= 480) return '480p (SD)';
  if (height >= 360) return '360p (SD)';
  if (height >= 240) return '240p (SD)';
  return `${height}p`;
};

app.get('/video-info', async (req, res) => {
  try {
    const videoUrl = req.query.url;
    if (!videoUrl) {
      return res.status(400).json({
        error: 'URL is required',
        example: 'http://localhost:3000/video-info?url=https://youtu.be/dQw4w9WgXcQ'
      });
    }

    const ytDlp = spawn(ytDlpPath, ['-J', '--no-warnings', '--no-check-certificate', videoUrl]);
    let jsonData = '';
    let errorData = '';

    ytDlp.stdout.on('data', (chunk) => jsonData += chunk.toString());
    ytDlp.stderr.on('data', (data) => errorData += data.toString());

    const result = await new Promise((resolve, reject) => {
      ytDlp.on('close', (code) => {
        if (code !== 0 || !jsonData) {
          const errMsg = `yt-dlp failed with code ${code}: ${errorData || 'No output'}`;
          console.error(errMsg);
          return reject(new Error(errMsg));
        }

        try {
          const info = JSON.parse(jsonData);
          const allowedResolutions = {
            '3840x2160': '2160p (4K)',
            '2560x1440': '1440p (2K)',
            '1920x1080': '1080p (HD)',
            '1280x720': '720p (HD)',
            '854x480': '480p (SD)',
            '640x360': '360p (SD)',
            '426x240': '240p (SD)',
            '256x144': '144p (SD)'
          };

          const seen = new Set();
          let mp3Added = false;
          const formats = [];

          for (const f of info.formats) {
            const resKey = `${f.width}x${f.height}`;
            const qualityLabel = allowedResolutions[resKey];
            const hasFilesize = f.filesize || f.filesize_approx;

            if (f.ext === 'mp4' && qualityLabel && hasFilesize && !seen.has(resKey)) {
              formats.push({
                itag: f.format_id,
                qualityLabel,
                resolution: resKey,
                aspectRatio: calculateAspectRatio(f.width, f.height),
                container: 'mp4',
                size: f.filesize ? `${(f.filesize / (1024 * 1024)).toFixed(2)} MB` :
                      f.filesize_approx ? `~${(f.filesize_approx / (1024 * 1024)).toFixed(2)} MB` : 'N/A'
              });
              seen.add(resKey);
            }

            if (!mp3Added && f.ext === 'mp3' && hasFilesize) {
              formats.push({
                itag: f.format_id,
                qualityLabel: 'Audio (MP3)',
                resolution: 'audio',
                aspectRatio: 'N/A',
                container: 'mp3',
                size: f.filesize ? `${(f.filesize / (1024 * 1024)).toFixed(2)} MB` :
                      f.filesize_approx ? `~${(f.filesize_approx / (1024 * 1024)).toFixed(2)} MB` : 'N/A'
              });
              mp3Added = true;
            }
          }

          resolve({
            title: info.title || 'Untitled',
            thumbnail: info.thumbnail || (info.thumbnails?.slice(-1)[0]?.url || ''),
            duration: info.duration_string || '',
            formats
          });
        } catch (parseError) {
          console.error('JSON parse error:', parseError);
          reject(new Error('Failed to parse video information'));
        }
      });
    });

    res.json(result);
  } catch (error) {
    console.error('Error in /video-info:', error);
    res.status(500).json({
      error: 'Failed to fetch video info',
      details: error.message,
      solution: 'Please check the URL and try again. If the problem persists, the video may not be available.'
    });
  }
});

app.get('/download', (req, res) => {
  const { url, itag } = req.query;

  if (!url || !itag) {
    return res.status(400).json({
      error: 'Missing parameters',
      required: ['url', 'itag'],
      example: 'http://localhost:3000/download?url=https://youtu.be/dQw4w9WgXcQ&itag=22'
    });
  }

  console.log(`Starting download for itag ${itag} from ${url}`);

  const ytDlp = spawn(ytDlpPath, [
    '-f', itag,
    '-o', '-',
    '--no-warnings',
    '--no-progress',
    url
  ]);

  res.setHeader('Content-Disposition', 'attachment; filename="video.mp4"');
  res.setHeader('Content-Type', 'video/mp4');

  ytDlp.stdout.pipe(res);

  ytDlp.stderr.on('data', (data) => {
    console.error('Download error:', data.toString());
  });

  ytDlp.on('error', (err) => {
    console.error('Process error:', err);
    res.status(500).end();
  });

  ytDlp.on('close', (code) => {
    if (code !== 0) {
      console.error(`Download failed with code ${code}`);
    }
  });
});

app.listen(PORT, () => {
  console.log(`\n🚀 YouTube Downloader Server Started!\n----------------------------------\nLocal: http://localhost:${PORT}\n\nEndpoints:\n- GET /video-info?url=YOUTUBE_URL\n- GET /download?url=YOUTUBE_URL&itag=FORMAT_ITAG\n\nPress Ctrl+C to stop\n`);
}).on('error', (err) => {
  console.error('Server failed to start:', err);
  if (err.code === 'EADDRINUSE') {
    console.log(`Port ${PORT} is already in use. Try changing the PORT environment variable.`);
  }
});
