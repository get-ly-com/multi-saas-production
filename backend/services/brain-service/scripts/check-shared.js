// lib/business.js is a copy of analytics-service/business.js (Railway builds each service from its
// own folder, so they can't share one file). This fails when the two have drifted apart.
const fs = require('fs');
const path = require('path');

const copy = path.join(__dirname, '..', 'lib', 'business.js');
const source = path.join(__dirname, '..', '..', 'analytics-service', 'business.js');
if (!fs.existsSync(source)) {
  console.log('analytics-service/business.js is not here (normal on a deploy), nothing to compare.');
  process.exit(0);
}
const same = fs.readFileSync(copy, 'utf8').replace(/\r\n/g, '\n') === fs.readFileSync(source, 'utf8').replace(/\r\n/g, '\n');
if (!same) {
  console.error('lib/business.js differs from analytics-service/business.js. Copy the analytics one over:');
  console.error('  cp ../analytics-service/business.js lib/business.js');
  process.exit(1);
}
console.log('lib/business.js matches analytics-service/business.js');
