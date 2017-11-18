import { Router } from "express";
import { ICreateTreeParams, ITree, ITreeEntry } from "gitresources";
import * as nconf from "nconf";
import * as git from "nodegit";
import * as utils from "../../utils";

export async function createTree(
    repoManager: utils.RepositoryManager,
    repo: string,
    tree: ICreateTreeParams): Promise<ITree> {

    const repository = await repoManager.open(repo);
    // TODO if base_tree exists look it up here and assume everything else is an insert
    const builder = await git.Treebuilder.create(repository, null);

    // build up the tree
    for (const node of tree.tree) {
        // TODO support content as well
        builder.insert(node.path, git.Oid.fromString(node.sha), parseInt(node.mode, 8));
    }

    const id = builder.write();
    return getTreeInternal(repository, id.tostrS());
}

async function getTree(repoManager: utils.RepositoryManager, repo: string, sha: string): Promise<ITree> {
    const repository = await repoManager.open(repo);
    return getTreeInternal(repository, sha);
}

async function getTreeRecursive(repoManager: utils.RepositoryManager, repo: string, sha: string): Promise<ITree> {
    const repository = await repoManager.open(repo);
    const root = await repository.getTree(sha);

    const walker = root.walk(false);
    return new Promise<ITree>((resolve, reject) => {
        walker.on("end", (entries: git.TreeEntry[]) => {
            const tree: ITree = {
                sha,
                tree: entries.map((entry) => treeEntryToITreeEntry(entry)),
                url: "",
            };
            resolve(tree);
        });

        walker.on("error", (error) => {
            reject(error);
        });

        // BUG:TYPINGS Missing definition leads to the below cast
        (walker as any).start();
    });
}

async function getTreeInternal(repository: git.Repository, sha: string): Promise<ITree> {
    const tree = await repository.getTree(sha);

    const entries = tree.entries();
    const outputEntries: ITreeEntry[] = [];
    for (const entry of entries) {
        const output = treeEntryToITreeEntry(entry);
        outputEntries.push(output);
    }

    return {
        sha,
        tree: outputEntries,
        url: "",
    };
}

/**
 * Helper function to convert from a nodegit TreeEntry to our ITreeEntry
 */
function treeEntryToITreeEntry(entry: git.TreeEntry): ITreeEntry {
    return {
        mode: entry.filemode().toString(8),
        path: entry.path(),
        sha: entry.id().tostrS(),
        size: 0, // TODO
        type: utils.GitObjectType[entry.type()],
        url: "", // TODO
    };
}

export function create(store: nconf.Provider, repoManager: utils.RepositoryManager): Router {
    const router: Router = Router();

    router.post("/repos/:repo/git/trees", (request, response, next) => {
        const blobP = createTree(repoManager, request.params.repo, request.body as ICreateTreeParams);
        return blobP.then(
            (blob) => {
                response.status(201).json(blob);
            },
            (error) => {
                response.status(400).json(error);
            });
    });

    router.get("/repos/:repo/git/trees/:sha", (request, response, next) => {
        const blobP = request.query.recursive === "1"
            ? getTreeRecursive(repoManager, request.params.repo, request.params.sha)
            : getTree(repoManager, request.params.repo, request.params.sha);
        return blobP.then(
            (blob) => {
                response.status(200).json(blob);
            },
            (error) => {
                response.status(400).json(error);
            });
    });

    return router;
}
