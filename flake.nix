{
  inputs = {
    nixpkgs.url = "https://flakehub.com/f/NixOS/nixpkgs/0.1";
    flake-parts.url = "github:hercules-ci/flake-parts";
    flake-parts.inputs.nixpkgs-lib.follows = "nixpkgs";
    git-hooks.url = "github:cachix/git-hooks.nix";
    git-hooks.inputs.nixpkgs.follows = "nixpkgs";
    treefmt-nix.url = "github:numtide/treefmt-nix";
    treefmt-nix.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs =
    {
      flake-parts,
      git-hooks,
      treefmt-nix,
      ...
    }@inputs:
    flake-parts.lib.mkFlake { inherit inputs; } {
      imports = [
        git-hooks.flakeModule
        treefmt-nix.flakeModule
      ];

      perSystem =
        {
          config,
          pkgs,
          ...
        }:
        {
          checks =
            let
              pnpmSrc = pkgs.lib.fileset.toSource {
                root = ./.;
                fileset = pkgs.lib.fileset.unions [
                  ./package.json
                  ./pnpm-lock.yaml
                  ./pnpm-workspace.yaml
                  (pkgs.lib.fileset.fileFilter (file: file.name == "package.json") ./.)
                ];
              };
              pnpmDeps = pkgs.fetchPnpmDeps {
                pname = "grok-build-web";
                src = pnpmSrc;
                fetcherVersion = 5;
                hash = "sha256-hpKn9w94vbU2Wy1vmDkT1ZwEcbNIqpy2e0lVY1ehx5A=";
              };
              runPnpm =
                check: command:
                pkgs.stdenvNoCC.mkDerivation {
                  name = "grok-build-web-${check}";
                  src = ./.;
                  inherit pnpmDeps;
                  nativeBuildInputs = [
                    pkgs.nodejs
                    pkgs.pnpm
                    pkgs.pnpmConfigHook
                  ];
                  buildPhase = command;
                  installPhase = "mkdir -p $out";
                };
            in
            {
              pnpmTest = runPnpm "pnpm-test" "pnpm test";
              pnpmTypecheck = runPnpm "pnpm-typecheck" "pnpm typecheck";
            };

          devShells.default = pkgs.mkShellNoCC {
            inputsFrom = [ config.pre-commit.devShell ];

            packages = with pkgs; [
              ni
              nodejs
              pnpm
            ];
          };

          pre-commit.settings = {
            hooks = {
              deadnix.enable = true;
              oxlint.enable = true;
              statix.enable = true;
            };
          };

          treefmt = {
            projectRootFile = "flake.nix";
            programs = {
              nixfmt.enable = true;
              oxfmt.enable = true;
            };
          };
        };

      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
    };
}
