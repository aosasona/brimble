import chalk from "chalk";
import fs, { ReadStream, createReadStream } from "fs";
import path from "path";
import { createServer } from "http";
import getPort from "get-port";
import { Request, Response } from "express";
import mime from "mime-types";
import inquirer from "inquirer";
import { detectFramework, log } from "@brimble/utils";
import { serveStack } from "../services";
import { dirValidator, FEEDBACK_MESSAGE } from "../helpers";
import { startScript } from "../services/start";
const open = require("better-opn");

const requestListener = (req: any, res: any) => {
  const htmlFile =
    req.url === "/"
      ? "index.html"
      : req.url.endsWith("/")
      ? `${req.url.slice(0, -1)}.html`
      : !req.url.includes(".")
      ? `${req.url}.html`
      : req.url;

  const filePath = path.resolve("./" + htmlFile);

  const fileExt = String(path.extname(filePath)).toLowerCase();
  const mimeType = mime.lookup(fileExt) || "application/octet-stream";

  staticFileHandler(req, res, filePath, mimeType);
};

const streamHandler = (
  statusCode: number,
  filePath: string,
  res: Response,
  contentType: string
): ReadStream => {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    server: "Brimble",
  });

  const stream = createReadStream(filePath).on("open", () => {
    stream.pipe(res);
  });

  return stream;
};

const staticFileHandler = (
  req: Request,
  res: Response,
  filePath: string,
  contentType: string
): ReadStream | void => {
  if (!fs.existsSync(filePath)) {
    if (filePath.endsWith(".html")) {
      filePath = path.resolve("./" + "index.html");
    }
  }

  const stream = streamHandler(200, filePath, res, contentType);

  if (stream) {
    stream
      .on("error", (err) => {
        streamHandler(404, path.resolve("./404.html"), res, "text/html").on(
          "error",
          (err) => {
            res.writeHead(404, {
              "Content-Type": "text/html",
              server: "Brimble",
              "Cache-Control": "public, max-age=0, must-revalidate",
            });
            // TODO: change it to a better 404 page
            res.end(`<h1>404: ${filePath} not found</h1>`);
          }
        );
      })
      .on("finish", () => {
        res.end();
      });
  }
};

export const customServer = (
  port: number,
  host: string,
  isOpen?: boolean
): void => {
  createServer(requestListener).listen(port, () => {
    let deployUrl = `${host}:${port}`;

    if (isOpen) {
      open(`${deployUrl}`);
    }

    console.log(chalk.green(`Serving to ${deployUrl}\n PID: ${process.pid}`));

    log.info(chalk.greenBright(FEEDBACK_MESSAGE));
  });
};

const serve = async (
  directory: string = ".",
  options: {
    port?: number;
    open?: boolean;
    buildCommand?: string;
    outputDirectory?: string;
    startOnly?: boolean;
  } = {}
) => {
  try {
    const { folder, files } = dirValidator(directory);

    const PORT = await getPort({
      port: options.port,
    });
    const HOST = "http://127.0.0.1";

    if (files.includes("package.json")) {
      const packageJson = require(path.resolve(folder, "package.json"));
      const framework = detectFramework(packageJson);
      let { installCommand, buildCommand, startCommand, outputDirectory } =
        framework.settings;

      const start = startCommand?.split(" ")[0];
      const startArgs = startCommand?.split(" ").slice(1);

      let build = options.buildCommand
        ? options.buildCommand.split(" ")[0]
        : buildCommand
        ? buildCommand.split(" ")[0]
        : "";
      let buildArgs = options.buildCommand
        ? options.buildCommand.split(" ").slice(1)
        : buildCommand
        ? buildCommand.split(" ").slice(1)
        : [];

      if (options.startOnly) {
        outputDirectory = outputDirectory || "dist";
        if (framework.slug === "remix-run") {
          startArgs?.push(options.outputDirectory || outputDirectory);
        } else {
          startArgs?.push(`--port=${PORT}`);
        }
        startScript({
          ci: { start, startArgs, build, buildArgs },
          dir: folder,
          server: {
            outputDirectory: options.outputDirectory || outputDirectory,
            isOpen: options.open,
            port: PORT,
            host: HOST,
          },
        });
      } else {
        if (files.includes("package-lock.json")) {
          installCommand = "npm install --include=dev";
        }

        inquirer
          .prompt([
            {
              name: "buildCommand",
              message: "Build command",
              default: buildCommand,
              when: !options.buildCommand,
            },
            {
              name: "outputDirectory",
              message: "Output directory",
              default: outputDirectory,
              when: !options.outputDirectory,
            },
          ])
          .then((answers) => {
            const { buildCommand, outputDirectory } = answers;
            const install = installCommand.split(" ")[0];
            const installArgs = installCommand.split(" ").slice(1);

            build = buildCommand
              ? buildCommand.split(" ")[0]
              : options.buildCommand
              ? options.buildCommand.split(" ")[0]
              : "";
            buildArgs = buildCommand
              ? buildCommand.split(" ").slice(1)
              : options.buildCommand
              ? options.buildCommand.split(" ").slice(1)
              : [];

            if (framework.slug === "remix-run") {
              startArgs?.push(outputDirectory || options.outputDirectory);
            } else {
              startArgs?.push(`--port=${PORT}`);
            }

            serveStack(
              folder,
              {
                install,
                installArgs,
                build,
                buildArgs,
                start,
                startArgs,
              },
              {
                outputDirectory: outputDirectory || options.outputDirectory,
                isOpen: options.open,
                port: PORT,
                host: HOST,
              }
            );
          });
      }
    } else if (files.includes("index.html")) {
      customServer(PORT, HOST, options.open);
    } else {
      throw new Error("The folder doesn't contain index.html or package.json");
    }
  } catch (err) {
    const { message } = err as Error;
    log.error(chalk.red(`Start failed with error: ${message}`));

    log.info(chalk.greenBright(FEEDBACK_MESSAGE));
    process.exit(1);
  }
};

export default serve;
