/* eslint-disable no-param-reassign */
/* eslint-disable no-continue */
/* eslint-disable global-require */
/* eslint-disable import/no-dynamic-require */
/* eslint-disable no-restricted-syntax */
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const striptags = require("striptags");
const sequential = require("promise-sequential");
const Sentry = require("@sentry/node");
const Tgfancy = require("tgfancy");
const { tagsAllowed, newLine, DATA_DIR } = require("./constants");

const config = require("../data/config");

function geModuleDataFilePath(moduleConfig) {
  const filePath = moduleConfig.description;
  return path.join(DATA_DIR, `${filePath}.json`);
}

function writeDataForModule(moduleConfig, data) {
  const filePath = geModuleDataFilePath(moduleConfig);
  return fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function readDataForModule(moduleConfig) {
  const filePath = geModuleDataFilePath(moduleConfig);

  try {
    const data = JSON.parse(fs.readFileSync(filePath));
    if (!data) throw new Error();
    return data;
  } catch (err) {
    return {
      processedIdMap: {}
    };
  }
}

function getElementHash(element) {
  return (
    element.hash ||
    crypto
      .createHash("md5")
      .update(JSON.stringify(element))
      .digest("hex")
  );
}

function notifyChange(bot, chatIds, element) {
  const { photo, url, message } = element;

  return Promise.all(
    chatIds.map(async chatId => {
      console.debug(`Sending message to ${chatId}`, element);

      if (photo) {
        try {
          bot.sendPhoto(chatId, photo, {
            disable_notification: true
          });
        } catch (err) {
          console.error("Error in sending photo", err);
        }
      }

      let finalMessage;
      const finalOpt = { parse_mode: "html", disable_web_page_preview: true };

      if (message && url) {
        finalMessage = `${striptags(element.message, tagsAllowed)}\n${url}`;
      } else if (message && !url) {
        finalMessage = striptags(element.message, tagsAllowed);
      } else if (!message && url) {
        finalMessage = url;
        finalOpt.disable_web_page_preview = false;
      } else {
        return;
      }

      bot.sendMessage(chatId, finalMessage, finalOpt);
    })
  );
}

function getModuleExecWrapper(bot, moduleConfig) {
  const {
    name = "noop",
    args = {},
    chatIds,
    formatter = e => e,
    attributes,
    filter
  } = moduleConfig;

  return async () => {
    if (config.doNotDisturb) {
      const { min, max } = config.doNotDisturb;
      const now = new Date();
      const hour = now.getUTCHours();
      if (hour < min || hour > max) {
        console.log(`Do not disturb is enabled (H${hour})`);
        return;
      }
    }

    const moduleData = readDataForModule(moduleConfig);

    try {
      const moduleExec = require(`./modules/${name}`);
      const moduleFetchedData = await moduleExec.fetch(
        args,
        moduleData.cache,
        bot
      );

      let elements = moduleFetchedData.elements || [];
      const cache = moduleFetchedData.cache || {};

      // Filtering elements
      if (filter) {
        elements = elements.filter(filter);
      }

      // Filtering attributes
      if (attributes) {
        elements = elements.map(e =>
          attributes.reduce((carry, attr) => {
            return { ...carry, ...{ [attr]: e[attr] } };
          }, {})
        );
      }

      console.log(
        `Executed: ${moduleConfig.description} - got ${elements.length}`,
        cache
      );

      await sequential(
        elements.map(element => async () => {
          const elementHash = getElementHash(element);
          if (moduleData.processedIdMap[elementHash]) {
            // console.debug(
            //   `Already processed ${elementHash} for ${moduleConfig.description}`
            // );
            return;
          }

          try {
            await notifyChange(bot, chatIds, formatter(element));
            moduleData.processedIdMap[elementHash] = Date.now();
            writeDataForModule(moduleConfig, moduleData);
          } catch (err) {
            Sentry.captureException(err);
            console.error(
              `Error in sending chat: ${moduleConfig.description}`,
              err.message
            );
          }
        })
      );

      moduleData.cache = cache;
      moduleData.lastError = null;
    } catch (err) {
      Sentry.captureException(err);
      console.error(`Error: ${moduleConfig.description}`, err.message);
      moduleData.lastError = err.message;
    } finally {
      moduleData.lastRunAt = Date.now();
      writeDataForModule(moduleConfig, moduleData);
    }
  };
}

function main() {
  const { telegram, modules } = config;

  const bot = new Tgfancy(telegram.token, {
    polling: telegram.polling,
    tgfancy: {
      chatIdResolution: false
    }
  });

  const botListeners = [];

  bot.whenMessage = fn => {
    botListeners.push(fn);
  };

  bot.on("message", msg => {
    console.log("New message", msg);
    botListeners.forEach(fn => fn(msg));
  });

  modules.forEach(moduleConfig => {
    const { fetchInterval = 60 } = moduleConfig;
    const moduleExec = getModuleExecWrapper(bot, moduleConfig);

    moduleExec();
    setInterval(moduleExec, fetchInterval * 1000);
  });
}

if (config.sentryDsn) {
  Sentry.init({
    dsn: config.sentryDsn
  });
}

main();
