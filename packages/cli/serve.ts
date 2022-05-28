import chalk from "chalk";
import fs, { ReadStream, createReadStream } from "fs";
import path from "path";
import { createServer } from "http";
import getPort from "get-port";
import { Request, Response } from "express";
import mime from "mime-types";
import inquirer from "inquirer";
import { detectFramework } from "@brimble/utils";
import { serveStack } from "./services";
import { dirValidator } from "./helpers";
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
        console.error(chalk.red(err.message));
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
  isOpen?: boolean,
  isDeploy?: boolean
): void => {
  createServer(requestListener).listen(port, () => {
    let deployUrl = `${host}:${port}`;

    if (isOpen) {
      open(`${deployUrl}`);
    }

    console.log(
      chalk.green(
        `${
          isDeploy
            ? `Successfully deployed to ${chalk.green(`Brimble`)} 🎉`
            : ""
        }\nServing to ${deployUrl}\n PID: ${process.pid}`
      )
    );
  });
};

const serve = async (
  directory: string = ".",
  options: {
    port?: number;
    open?: boolean;
    deploy?: boolean;
    buildCommand?: string;
    outputDirectory?: string;
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

          const build = buildCommand
            ? buildCommand.split(" ")[0]
            : options.buildCommand
            ? options.buildCommand.split(" ")[0]
            : "";
          const buildArgs = buildCommand
            ? buildCommand.split(" ").slice(1)
            : options.buildCommand
            ? options.buildCommand.split(" ").slice(1)
            : [];

          const start = startCommand?.split(" ")[0];
          const startArgs = startCommand?.split(" ").slice(1);
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
              isDeploy: options.deploy,
              port: PORT,
              host: HOST,
            }
          );
        });
    } else if (files.includes("index.html")) {
      customServer(PORT, HOST, options.open, options.deploy);
    } else {
      throw new Error("The folder doesn't contain index.html or package.json");
    }
  } catch (err) {
    const { message } = err as Error;
    console.error(chalk.red(`error: ${message}`));
    process.exit(1);
  }
};

export default serve;
