import { Context, Effect, Layer, Ref } from "effect";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly root: string;
}

export interface CreateProjectInput {
  readonly name?: string;
  readonly root: string;
}

export type CreateProjectResult =
  | { readonly ok: true; readonly project: Project }
  | { readonly ok: false; readonly message: string };

export interface ProjectRegistryShape {
  readonly list: Effect.Effect<readonly Project[]>;
  readonly create: (input: CreateProjectInput) => Effect.Effect<CreateProjectResult>;
}

export class ProjectRegistry extends Context.Service<ProjectRegistry, ProjectRegistryShape>()(
  "@grok-build-web/server/ProjectRegistry",
) {}

const NAME_LIMIT = 80;

export interface ProjectRegistryOptions {
  readonly maxProjects: number;
}

export const makeProjectRegistry = (
  options: ProjectRegistryOptions,
): Effect.Effect<ProjectRegistryShape> =>
  Effect.gen(function* () {
    const projectsRef = yield* Ref.make<readonly Project[]>([]);

    const list = Ref.get(projectsRef);

    const create = (input: CreateProjectInput) =>
      Effect.gen(function* () {
        // Spread by code point so the cap cannot cut a surrogate pair into a lone surrogate.
        const name = [...(input.name ?? basename(input.root)).trim()].slice(0, NAME_LIMIT).join("");
        if (name === "") {
          return { ok: false as const, message: "Project name must not be empty" };
        }
        const project: Project = { id: randomUUID(), name, root: input.root };
        return yield* Ref.modify(
          projectsRef,
          (projects): [CreateProjectResult, readonly Project[]] => {
            if (projects.some((existing) => existing.root === project.root)) {
              return [
                { ok: false, message: `A project already uses this directory: ${input.root}` },
                projects,
              ];
            }
            if (projects.length >= options.maxProjects) {
              return [
                { ok: false, message: `Project limit reached (${options.maxProjects})` },
                projects,
              ];
            }
            return [{ ok: true, project }, [...projects, project]];
          },
        );
      });

    return { list, create };
  });

export const projectRegistryLayer = (
  options: ProjectRegistryOptions,
): Layer.Layer<ProjectRegistry> => Layer.effect(ProjectRegistry, makeProjectRegistry(options));
