import inquirer from 'inquirer';
import {cwd} from 'process';
import tar from 'tar';
import crypto from 'crypto';
import fs from 'fs';
import AWS from 'aws-sdk';
import path from 'path';
import mime from 'mime-types';
import keytar from 'keytar';
import yargs from 'yargs';
import slash from 'slash';
import aws4 from 'aws4';
import axios from 'axios';

function parseArgumentsIntoOptions() {
  return yargs
    .usage('Usage: hcs <command> [options]')
    .command('build', 'Create a tar.gz file for the app', (yargs) => {
      return yargs.option('latest', {
        type: 'boolean',
        description: 'Version will be replaced by \'latest\' instead of what is in the app.json. Do NOT use this unless you know what you are doing!'
      })
    }, build)
    .command('publish', 'Build the app and upload it to the Homey Community Store', (yargs) => {
      return yargs;
    },  publish)
    .command('logout', 'Remove all credentials', (yargs) => {
      return yargs
    }, logout)
    .help()
    .demandCommand(1, 'You need to enter at least one command')
    .argv;
}

async function promptForAccessKeyId() {
  const questions = [];
  questions.push({
    type: 'input',
    name: 'accessKeyId',
    message: 'Please provide your access key id'
  });
  const answers = await inquirer.prompt(questions);
  return answers.accessKeyId;
}

async function promptForAccessKeySecret() {
  const questions = [];
  questions.push({
    type: 'input',
    name: 'accessKeySecret',
    message: 'Please provide your access key secret'
  });
  const answers = await inquirer.prompt(questions);
  return answers.accessKeySecret;
}

function determineCategory(appInfo) {
  if (!appInfo.category) {
    return ['general']
  }
  return Array.isArray(appInfo.category) ? appInfo.category : [appInfo.category];
}

function createTar(appInfo, argv) {
  return new Promise((resolve, reject) => {
    let version = `v${appInfo.version}`;
    if (argv.latest) {
      version = 'latest';
    }
    const tarFile = `${appInfo.id}-${version}.tar.gz`;
    tar.c({
      gzip: true,
      file: tarFile,
      filter: (path, stats) => {
        if (!path.includes('node_modules')) {
          if (stats.isFile() && path.startsWith('.')) {
            return false;
          }
          if (stats.isFile() && path.includes(tarFile)) {
            return false
          }
        }
        return true;
      }
    }, [`./`]).then((_result) => {
      const hash = crypto.createHash('sha1');
      const readStream = fs.createReadStream(`${cwd()}/${tarFile}`);
      readStream.on('error', reject);
      readStream.on('data', chunk => hash.update(chunk));
      readStream.on('end', () => resolve({hash: hash.digest('hex'), filename: tarFile}));
    }, (error) => {
      reject(error);
    });
  });
}

function getI18nDescriptions() {
  const lang = {}
  fs.readdirSync(`${cwd()}/`).forEach((path) => {
    if (path.toLowerCase() === 'readme.txt') {
      lang.en = fs.readFileSync(`${cwd()}/${path}`, 'utf8');
    } else if (path.toLowerCase().includes('readme') && path.toLowerCase().endsWith('.txt')) {
      const language = path.toLowerCase().split('.')[1];
      lang[language] = fs.readFileSync(`${cwd()}/${path}`, 'utf8');
    }
  });
  if (Object.keys(lang).length < 1) {
    fs.readdirSync(`${cwd()}/`).forEach((path) => {
      if (path.toLowerCase() === 'readme.md') {
        lang.en = fs.readFileSync(`${cwd()}/${path}`, 'utf8');
      } else if (path.toLowerCase().includes('readme') && path.toLowerCase().endsWith('.md')) {
        const language = path.toLowerCase().split('.')[1];
        lang[language] = fs.readFileSync(`${cwd()}/${path}`, 'utf8');
      }
    });
  }

  return lang;
}

export async function cli(args) {
  parseArgumentsIntoOptions(args);
}

function uploadToS3(s3Path, bucketName, root) {
  let s3 = new AWS.S3();

  function walkSync(currentDirPath, callback) {
    fs.readdirSync(currentDirPath).forEach((name) => {
      const filePath = path.join(currentDirPath, name);
      const stat = fs.statSync(filePath);
      if (stat.isFile()) {
        callback(filePath, stat);
      } else if (stat.isDirectory()) {
        walkSync(filePath, callback);
      }
    });
  }

  walkSync(s3Path, (filePath, _stat) => {
    const bucketPath = filePath;
    const key = slash(root + bucketPath.split(s3Path)[1]).replace(/\\/g, '/');
    if (!['.svg', '.png', '.jpeg', '.jpg', '.gz'].includes(path.extname(filePath)) || filePath.includes('node_modules') || filePath.includes('.github')) {
      return;
    }
    const contentType = mime.contentType(path.extname(bucketPath));
    let params = {
      Bucket: bucketName,
      ACL: 'public-read',
      ContentType: contentType,
      Key: key,
      Body: fs.readFileSync(filePath)
    };
    s3.putObject(params, function (err, _data) {
      if (err) {
        console.log(err)
      } else {
        console.log('Successfully uploaded ' + bucketPath + ' to ' + bucketName + ' as ' + key);
      }
    });
  });
}

async function build(argv) {
  console.log('Building the app');
  let tar = {};
  try {
    const appInfo = require(`${cwd()}/app.json`);
    tar = await createTar(appInfo, argv);
  } catch (e) {
    console.error(e);
    return;
  }
  console.log(`Build finished: ${cwd()}/${tar.filename}`)
}

function getCredentials(account) {
  return new Promise((resolve, reject) => {
    keytar.getPassword('hcs-cli', account).then((result) => {
      resolve(result ? result : false);
    }).catch(reject);
  });
}

function setCredentials(account, password) {
  return new Promise((resolve, reject) => {
    keytar.setPassword('hcs-cli', account, password).then((_result) => {
      resolve(true);
    }).catch(reject);
  });
}

async function logout(_argv) {
  const allCreds = await keytar.findCredentials('hcs-cli');
  const promises = allCreds.map(async creds => {
    await keytar.deletePassword('hcs-cli', creds.account);
  });
  await Promise.allSettled(promises);
  console.log('You have been signed out');
}

async function publish(argv) {
  let appInfo = {};
  let tar = {};
  try {
    appInfo = require(`${cwd()}/app.json`);
    tar = await createTar(appInfo, argv);
  } catch (e) {
    console.error(e);
    return;
  }

  let app = {
    id: appInfo.id,
    added: Date.now(),
    modified: Date.now(),
    versions: [{
      id: appInfo.id,
      summary: appInfo.description,
      hash: tar.hash,
      filename: tar.filename,
      added: Date.now(),
      modified: Date.now(),
      sdk: appInfo.sdk,
      version: appInfo.version,
      compatibility: appInfo.compatibility,
      name: appInfo.name,
      icon: appInfo.icon,
      brandColor: appInfo.brandColor || '#000000',
      tags: appInfo.tags,
      category: determineCategory(appInfo),
      author: appInfo.author,
      contributors: appInfo.contributors,
      source: appInfo.source,
      homepage: appInfo.homepage,
      support: appInfo.support,
      images: {
        small: appInfo.images ? appInfo.images.small : null,
        large: appInfo.images ? appInfo.images.large : null,
      },
      permissions: appInfo.permissions,
      contributing: appInfo.contributing,
      bugs: appInfo.bugs,
      homeyCommunityTopicId: appInfo.homeyCommunityTopicId,
      signals: appInfo.signals,
      flow: appInfo.flow,
      discovery: appInfo.discovery,
      drivers: appInfo.drivers,
      description: getI18nDescriptions(),
      enabled: true
    }]
  };

  if (fs.existsSync(`${cwd()}/.homeychangelog.json`)) {
    app.changelog = require(`${cwd()}/.homeychangelog.json`);
    app.versions[0].changelog = require(`${cwd()}/.homeychangelog.json`);
  }

  const locales = {};
  const appVersion = app.versions[0];
  if (appVersion.name) {
    Object.keys(appVersion.name).forEach(lang => {
      locales[lang] = {name: appVersion.name[lang]}
    });
  }

  if (appVersion.summary) {
    Object.keys(appVersion.summary).forEach(lang => {
      locales[lang] = {
        ...locales[lang],
        description: appVersion.summary[lang]
      }
    });
  }

  if (appVersion.description) {
    Object.keys(appVersion.description).forEach(lang => {
      locales[lang] = {
        ...locales[lang],
        description: appVersion.description[lang]
      }
    });
  }

  if (appVersion.tags) {
    Object.keys(appVersion.tags).forEach(lang => {
      locales[lang] = {
        ...locales[lang],
        tags: appVersion.tags[lang]
      }
    });
  }
  if (appVersion.changelog) {

    Object.keys(appVersion.changelog).forEach(version => {
      Object.keys(appVersion.changelog[version]).forEach(lang => {
        if (!locales[lang]) {
          locales[lang] = {};
        }
        if (!locales[lang].changelog) {
          locales[lang].changelog = {};
        }
        locales[lang].changelog[version] = appVersion.changelog[version][lang];
      })
    });
  }

  app.versions[0].locales = locales;

  const creds = await keytar.findCredentials('hcs-cli').catch(console.error);
  let accessKeyId;
  let accessKeySecure;
  if (creds && creds.length === 1) {
    accessKeyId = creds[0].account;
    accessKeySecure = creds[0].password;
  } else {
    accessKeyId = await promptForAccessKeyId();
    accessKeySecure = await getCredentials(accessKeyId).catch(console.error);
  }

  if (accessKeySecure === false) {
    //ask for credentials;
    const accessKeySecret = await promptForAccessKeySecret();
    if (accessKeySecret) {
      const success = await setCredentials(accessKeyId, accessKeySecret).catch(console.error);
      if (!success) {
        console.log('Something went wrong storing your credentials');
        return;
      }
    } else {
      return;
    }
    accessKeySecure = accessKeySecret;
  }

  AWS.config = new AWS.Config({
    region: 'eu-central-1',
    accessKeyId: accessKeyId,
    secretAccessKey: accessKeySecure
  });

  const request = {
    host: '4c23v5xwtc.execute-api.eu-central-1.amazonaws.com',
    method: 'POST',
    url: `https://4c23v5xwtc.execute-api.eu-central-1.amazonaws.com/staging/apps/publish`,
    data: app, // object describing the foo
    body: JSON.stringify(app), // aws4 looks for body; axios for data
    path: `/staging/apps/publish`,
    headers: {
      'content-type': 'application/json'
    }
  }

  const signedRequest = aws4.sign(request,
    {
      // assumes user has authenticated and we have called
      // AWS.config.credentials.get to retrieve keys and
      // session tokens
      secretAccessKey: AWS.config.credentials.secretAccessKey,
      accessKeyId: AWS.config.credentials.accessKeyId
    })

  delete signedRequest.headers['Host']
  delete signedRequest.headers['Content-Length']

  const response = await axios(signedRequest).catch(console.error);

  if (response && response.data && response.data.body) {
    const {success, msg} = response.data.body;
    if (!success) {
      console.error(msg);
      return;
    }
    console.log(msg);
    //PUSH TAR FILE AND IMAGES TO S3!
    uploadToS3(cwd(), 'homey-community-store', `${app.id}/${appInfo.version}`);
  } else {
    console.error('Failed pushing to the DB');
  }

}
