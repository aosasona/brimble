import { detectFramework, log } from "@brimble/utils";
import chalk from "chalk";
import dotenv from "dotenv";
import fs from "fs";
import inquirer from "inquirer";
import isValidDomain from "is-valid-domain";
import path from "path";
import Conf from "configstore";
import forever from "forever-monitor";
import ora from "ora";
import slugify from "slugify";
const open = require("better-opn");
import {
  dirValidator,
  FEEDBACK_MESSAGE,
  getFiles,
  getIgnoredFiles,
  git,
  msToTime,
  projectConfig,
  setupAxios,
  socket,
} from "../helpers";
import { GIT_TYPE } from "@brimble/models";

dotenv.config();

const config = new Conf("brimble");

const deploy = async (
  directory: string = ".",
  options: {
    open: boolean;
    domain: string;
    silent: boolean;
    name: string;
    projectID: string;
  } = {
    open: false,
    domain: "",
    silent: false,
    name: "",
    projectID: "",
  }
) => {
  try {
    const token = config.get("token");
    if (!token) {
      log.error(chalk.red("You must login first"));
      process.exit(1);
    }
    const { folder, files } = dirValidator(directory);

    const projectConf = await projectConfig();
    const proj = projectConf.get("project");

    let filesToUpload = getFiles(folder);
    let buildCommand = "";
    let outputDirectory = "";
    const hasPackageJson = files.includes("package.json");

    if (hasPackageJson) {
      const ignoredFiles = await getIgnoredFiles(folder);
      ignoredFiles.forEach((file: string) => {
        filesToUpload = filesToUpload.filter((f: any) => !f.includes(file));
      });
      const packageJson = require(path.resolve(folder, "package.json"));
      const framework = detectFramework(packageJson);
      buildCommand = framework.settings.buildCommand;
      outputDirectory = framework.settings.outputDirectory || "dist";
    }

    if (!proj || !proj.id) {
      if (!options.projectID || !config.get(options.projectID)) {
        const { createProject } = await inquirer.prompt([
          {
            type: "confirm",
            name: "createProject",
            message: "Initialize project?",
            default: true,
          },
        ]);

        if (!createProject) {
          log.warn("Project not initialized");
          process.exit(1);
        }

        const oauth = config.get("oauth");
        const hasGit = await git.revparse(["--is-inside-work-tree"]);

        if (
          oauth &&
          (oauth.toUpperCase() === GIT_TYPE.GITHUB ||
            oauth.toUpperCase() === GIT_TYPE.GITLAB ||
            oauth.toUpperCase() === GIT_TYPE.BITBUCKET) &&
          hasGit
        ) {
          const spinner = ora("Searching for repositories").start();

          setupAxios(token)
            .get(`/repos/${oauth.toLowerCase()}`)
            .then(async ({ data }) => {
              spinner.stop();
              const listRepos = async (repos: any[]) => {
                const { repo } = await inquirer.prompt([
                  {
                    type: "list",
                    name: "repo",
                    message: "Select a repository",
                    choices: [
                      ...repos?.map((repo: any) => ({
                        name: repo.name,
                        value: {
                          id: repo.id,
                          name: repo.name,
                          full_name: repo.full_name,
                        },
                      })),
                      {
                        name: "Not listed? Add it",
                        value: null,
                      },
                    ],
                  },
                ]);

                if (repo === null) {
                  open(
                    `https://github.com/apps/brimble-build/installations/new`
                  );
                  socket.on(`${config.get("id")}:repos`, async (repos: any) => {
                    await listRepos(repos);
                  });
                } else {
                  const remoteRepo = await git.getConfig("remote.origin.url");
                  if (
                    remoteRepo &&
                    !remoteRepo.value?.includes(repo.full_name)
                  ) {
                    const { changeRemote } = await inquirer.prompt([
                      {
                        type: "confirm",
                        name: "changeRemote",
                        message: "Change remote repository?",
                        default: true,
                      },
                    ]);
                    if (changeRemote) {
                      open(
                        `https://github.com/apps/brimble-build/installations/new`
                      );

                      socket.on(
                        `${config.get("id")}:repos`,
                        async (repos: any) => {
                          await listRepos(repos);
                        }
                      );
                    } else {
                      process.exit(1);
                    }
                  } else {
                    inquirer
                      .prompt([
                        {
                          name: "name",
                          message: "Name of the project",
                          default: slugify(path.basename(folder), {
                            lower: true,
                          }),
                          when: !options.name,
                          validate: (input: string) => {
                            if (!input) {
                              return "Please enter a project name";
                            } else {
                              return setupAxios(token)
                                .get(
                                  `/exists?name=${slugify(input, {
                                    lower: true,
                                  })}`
                                )
                                .then(() => {
                                  return true;
                                })
                                .catch((err) => {
                                  if (err.response) {
                                    return `${err.response.data.msg}`;
                                  } else {
                                    return `${err.message}`;
                                  }
                                });
                            }
                          },
                        },
                        {
                          name: "buildCommand",
                          message: "Build command",
                          default: buildCommand,
                          when: hasPackageJson,
                        },
                        {
                          name: "outputDirectory",
                          message: "Output directory",
                          default: outputDirectory,
                          when: hasPackageJson,
                        },
                        {
                          name: "domain",
                          message: "Domain name",
                          default: options.name
                            ? `${options.name}.brimble.app`
                            : ({ name }: { name: string }) => {
                                return name ? `${name}.brimble.app` : "";
                              },
                          when: !options.domain,
                          validate: (input: string) => {
                            if (isValidDomain(input)) {
                              return setupAxios(token)
                                .get(`/exists?domain=${input}`)
                                .then(() => {
                                  return true;
                                })
                                .catch((err) => {
                                  if (err.response) {
                                    return `${err.response.data.msg}`;
                                  }
                                  return `${err.message}`;
                                });
                            } else {
                              return `${input} is not a valid domain`;
                            }
                          },
                        },
                      ])
                      .then(async (answers) => {
                        const { name, buildCommand, outputDirectory, domain } =
                          answers;

                        if (createProject) {
                          setupAxios(token)
                            .post(`/init`, {
                              name: slugify(name, { lower: true }),
                              repo,
                            })
                            .then(async ({ data }) => {
                              projectConf.set("project", {
                                id: data.projectId,
                              });
                              await sendToServer({
                                folder,
                                filesToUpload,
                                buildCommand,
                                outputDirectory,
                                projectId: data.projectId,
                                name: slugify(name || options.name, {
                                  lower: true,
                                }),
                                domain,
                                options,
                                token,
                                project: {},
                              });
                            });
                        }
                      });
                  }
                }
              };
              await listRepos(data.data);
            })
            .catch((err) => {
              spinner.fail("Error finding repository\n" + err.message);
            });
        } else {
          log.error(chalk.red("You must initialize a git repository first"));
          process.exit(1);
        }
      } else {
        const project = config.get(options.projectID);
        projectConf.set("project", { id: options.projectID });

        filesToUpload = project?.filesToUpload?.length
          ? project.filesToUpload
          : project?.changedFiles;

        await sendToServer({
          folder,
          filesToUpload,
          buildCommand: project.buildCommand || buildCommand,
          outputDirectory: project.outputDirectory || outputDirectory,
          projectId: +options.projectID,
          name: options.name || project.name,
          domain: options.domain,
          options,
          token,
          project,
        });
      }
    } else {
      const project = config.get(proj.id);
      if (!project) {
        log.error(chalk.red("Project not found"));
        process.exit(1);
      }

      filesToUpload = project?.filesToUpload?.length
        ? project.filesToUpload
        : project?.changedFiles;

      await sendToServer({
        folder,
        filesToUpload,
        buildCommand: project.buildCommand || buildCommand,
        outputDirectory: project.outputDirectory || outputDirectory,
        projectId: proj.id,
        name: options.name || project.name,
        domain: options.domain,
        options,
        token,
        project,
      });
    }
  } catch (err) {
    const { message } = err as Error;
    log.error(chalk.red(`Error deploying to Brimble 😭\n${message}`));
    process.exit(1);
  }
};

const sendToServer = async ({
  folder,
  projectId,
  filesToUpload,
  domain,
  name,
  buildCommand,
  outputDirectory,
  options,
  token,
  project,
}: {
  folder: string;
  projectId: number;
  filesToUpload: string[];
  domain: string;
  name: string;
  buildCommand: string;
  outputDirectory: string;
  options: {
    open: boolean;
    silent: boolean;
  };
  token: string;
  project: any;
}) => {
  const payload = {
    name,
    filesToUpload,
  };

  const uploadSpinner = ora(
    chalk.green(`Uploading ${filesToUpload.length} files...`)
  ).start();

  config.set(`${projectId}`, !project ? payload : { ...project, ...payload });

  const upload = async (file: string) => {
    const filePath = path.resolve(folder, file);
    // get directory
    const directory = file.split("/").slice(0, -1).join("/");

    const useRootDir = directory.split(`${path.basename(folder)}/`);
    useRootDir.shift();
    const rootDir = `${path.basename(folder)}/${useRootDir.join("")}`;

    await setupAxios(token)
      .post(
        `/cli/upload`,
        {
          dir: `${projectId}/${rootDir}`,
          file: fs.createReadStream(filePath),
        },
        {
          headers: {
            "Content-Type": "multipart/form-data",
          },
        }
      )
      .then(() => {
        const filesLeft = filesToUpload.filter((f: string) => f !== file);
        config.set(`${projectId}`, { ...payload, filesToUpload: filesLeft });
      })
      .catch((err) => {
        if (err.response) {
          log.error(
            chalk.red(
              `Error uploading ${filePath}
              ${chalk.bold(`\n${err.response.data.msg}`)}
            `
            )
          );
        } else if (err.request) {
          log.error(
            chalk.red(
              `Error uploading ${filePath}
              \n Make sure you have a good internet connection
              `
            )
          );
        } else {
          log.error(chalk.red(`Error uploading ${filePath} \n${err.message}`));
        }

        log.info(chalk.greenBright(FEEDBACK_MESSAGE));
        process.exit(1);
      });
  };

  const uploadTime = new Date();
  await Promise.all(filesToUpload.map(upload)).then(() => {
    uploadSpinner.succeed(
      chalk.green(
        `Uploaded ${filesToUpload.length} files in ${
          new Date().getTime() - uploadTime.getTime()
        }ms`
      )
    );
  });

  const deploySpinner = ora(`Setting up project ${chalk.bold(name)}`).start();

  const deployTime = new Date();
  setupAxios(token)
    .post(
      `/cook`,
      {
        uuid: projectId,
        dir: path.basename(folder),
        domain,
        name,
        buildCommand,
        outputDirectory,
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    )
    .then(() => {
      config.set(`${projectId}`, {
        name,
        buildCommand,
        outputDirectory,
        changedFiles: [],
        filesToUpload: [],
      });

      if (process.platform === "win32") {
        const spawn = require("cross-spawn");
        spawn.sync(
          "npx",
          [
            "forever",
            "start",
            "--append",
            "--uid",
            name,
            path.join("../dist/index.js"),
            "watch",
            "-pID",
            `${projectId}`,
            `${folder}`,
          ],
          { stdio: "inherit", detached: true }
        );
      } else {
        forever.start(
          ["brimble", "watch", "-pID", `${projectId}`, `${folder}`],
          {
            max: 1,
            silent: true,
            uid: name,
          }
        );
      }

      if (options.silent) {
        log.warn(chalk.yellow(`Silent mode enabled`));
        log.info(
          chalk.blue(`Use ${chalk.bold(`brimble logs ${name}`)} to view logs`)
        );
        log.info(chalk.greenBright(FEEDBACK_MESSAGE));
        process.exit(0);
      } else {
        deploySpinner.color = "yellow";
        deploySpinner.text = chalk.yellow(
          `This might take a minute, please wait until the project is ready or use ${chalk.bold(
            `brimble logs ${name}`
          )} to view logs`
        );
      }

      socket.on(
        `${projectId}-deployed`,
        ({ url, message }: { url: string; message: string }) => {
          deploySpinner.succeed(chalk.green(`Project deployed to Brimble 🎉`));
          if (message) {
            log.warn(chalk.yellow.bold(`${message}`));
          }
          if (options.open) {
            log.info(chalk.green(`Opening ${url}`));
            require("better-opn")(url);
          } else {
            log.info(chalk.green(`Your site is available at ${url}`));
          }

          log.info(
            chalk.yellow(
              `Use ${chalk.bold(`brimble cook -n ${name}`)} to deploy again`
            )
          );

          // end execution time
          const end = new Date();

          // calculate execution time
          const time = msToTime(end.getTime() - deployTime.getTime());
          log.info(chalk.green(`Time to deploy: ${chalk.bold(`${time}`)}`));

          log.info(chalk.greenBright(FEEDBACK_MESSAGE));

          process.exit(0);
        }
      );

      socket.on(`${projectId}-error`, ({ message }: { message: string }) => {
        deploySpinner.fail(chalk.red(`Project failed to deploy 🚨`));
        log.error(
          chalk.red(`${message} Using ${chalk.bold(`brimble logs ${name}`)}`)
        );
        process.exit(1);
      });
    })
    .catch((err) => {
      if (err.response) {
        deploySpinner.fail(
          chalk.red(`Error deploying to Brimble 😭\n${err.response.data.msg}`)
        );
      } else if (err.request) {
        deploySpinner.fail(
          chalk.red(`Make sure you are connected to the internet`)
        );
      } else {
        deploySpinner.fail(
          chalk.red(`Error deploying to Brimble 😭 \n ${err.message}`)
        );
      }
      log.info(chalk.greenBright(FEEDBACK_MESSAGE));
      process.exit(1);
    });
};

export default deploy;
