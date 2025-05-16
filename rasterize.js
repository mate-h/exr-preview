const { promises: fs } = require('fs');
const { join } = require('path');
const { Resvg } = require('@resvg/resvg-js');

async function main() {
  const svgPath = join(__dirname, 'logo.svg');
  const pngPath = join(__dirname, 'logo.png');
  const svg = await fs.readFile(svgPath);

  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: 256 }, // 256px wide, auto height
    background: 'rgba(0,0,0,0)', // transparent background
  });

  const pngData = resvg.render();
  const pngBuffer = pngData.asPng();

  await fs.writeFile(pngPath, pngBuffer);
  console.log('Rasterized logo.svg to logo.png');
}

main();