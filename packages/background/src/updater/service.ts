import { ChainInfo } from "@keplr-wallet/types";
import Axios from "axios";
import { KVStore } from "@keplr-wallet/common";
import { ChainIdHelper } from "@keplr-wallet/cosmos";
import { ChainInfoWithEmbed, ChainsService } from "../chains";
import { Mutable } from "utility-types";

export class ChainUpdaterService {
  protected chainsService!: ChainsService;

  constructor(protected readonly kvStore: KVStore) {}

  init(chainsService: ChainsService) {
    this.chainsService = chainsService;
  }

  async putUpdatedPropertyToChainInfo(
    chainInfo: ChainInfo
  ): Promise<ChainInfo> {
    const updatedProperty = await this.getUpdatedChainProperty(
      chainInfo.chainId
    );

    const chainId = ChainIdHelper.parse(chainInfo.chainId);
    const updatedChainId = ChainIdHelper.parse(
      updatedProperty.chainId || chainInfo.chainId
    );

    // If the saved property is lesser than the current chain id, just ignore.
    if (updatedChainId.version < chainId.version) {
      return chainInfo;
    }

    const features = chainInfo.features ?? [];
    for (const updatedFeature of updatedProperty.features ?? []) {
      if (!features.includes(updatedFeature)) {
        features.push(updatedFeature);
      }
    }

    return {
      ...chainInfo,
      ...{
        chainId: updatedProperty.chainId || chainInfo.chainId,
        rpc: updatedProperty.rpc || chainInfo.rpc,
        rest: updatedProperty.rest || chainInfo.rest,
        features,
      },
    };
  }

  async clearUpdatedProperty(chainId: string) {
    await this.kvStore.set(ChainIdHelper.parse(chainId).identifier, null);

    this.chainsService.clearCachedChainInfos();
  }

  async tryUpdateChain(chainId: string) {
    const chainInfo = await this.chainsService.getChainInfo(chainId);

    // If chain id is not fomatted as {chainID}-{version},
    // there is no way to deal with the updated chain id.
    if (!ChainIdHelper.hasChainVersion(chainInfo.chainId)) {
      return;
    }

    const updates = await ChainUpdaterService.checkChainUpdate(chainInfo);

    if (updates.explicit || updates.slient) {
      const currentVersion = ChainIdHelper.parse(chainInfo.chainId);

      if (updates.chainId) {
        const fetchedChainId = updates.chainId;
        const fetchedVersion = ChainIdHelper.parse(fetchedChainId);

        if (
          currentVersion.identifier === fetchedVersion.identifier &&
          currentVersion.version < fetchedVersion.version
        ) {
          await this.saveChainProperty(currentVersion.identifier, {
            chainId: fetchedChainId,
          });
        }
      }

      if (updates.features && updates.features.length > 0) {
        const savedChainProperty = await this.getUpdatedChainProperty(
          chainInfo.chainId
        );

        const updateFeatures = savedChainProperty.features ?? [];

        for (const feature of updates.features) {
          if (!updateFeatures.includes(feature)) {
            updateFeatures.push(feature);
          }
        }

        await this.saveChainProperty(currentVersion.identifier, {
          features: updateFeatures,
        });
      }
    }
  }

  private async getUpdatedChainProperty(
    chainId: string
  ): Promise<Partial<ChainInfo>> {
    const version = ChainIdHelper.parse(chainId);

    return await this.loadChainProperty(version.identifier);
  }

  private async saveChainProperty(
    identifier: string,
    chainInfo: Partial<ChainInfo>
  ) {
    const saved = await this.loadChainProperty(identifier);

    await this.kvStore.set(identifier, {
      ...saved,
      ...chainInfo,
    });

    this.chainsService.clearCachedChainInfos();
  }

  private async loadChainProperty(
    identifier: string
  ): Promise<Partial<ChainInfo>> {
    const chainInfo = await this.kvStore.get<Partial<ChainInfo>>(identifier);
    if (!chainInfo) return {};
    return chainInfo;
  }

  /**
   * Returns wether the chain has been changed.
   * Currently, only check the chain id has been changed.
   * @param chainInfo Chain information.
   */
  public static async checkChainUpdate(
    chainInfo: Readonly<ChainInfo>
  ): Promise<{
    explicit: boolean;
    slient: boolean;

    chainId?: string;
    features?: string[];
  }> {
    const chainId = chainInfo.chainId;

    // If chain id is not fomatted as {chainID}-{version},
    // there is no way to deal with the updated chain id.
    if (!ChainIdHelper.hasChainVersion(chainId)) {
      return {
        explicit: false,
        slient: false,
      };
    }

    const instance = Axios.create({
      baseURL: chainInfo.rpc,
    });

    // Get the status to get the chain id.
    const result = await instance.get<{
      result: {
        node_info: {
          network: string;
        };
      };
    }>("/status");

    const resultChainId = result.data.result.node_info.network;

    const version = ChainIdHelper.parse(chainId);
    const fetchedVersion = ChainIdHelper.parse(resultChainId);

    // TODO: Should throw an error?
    if (version.identifier !== fetchedVersion.identifier) {
      return {
        explicit: false,
        slient: false,
      };
    }

    const restInstance = Axios.create({
      baseURL: chainInfo.rest,
    });

    let ibcGoUpdates = false;
    try {
      if (!chainInfo.features || !chainInfo.features.includes("ibc-go")) {
        // If the chain uses the ibc-go module separated from the cosmos-sdk,
        // we need to check it because the REST API is different.
        const result = await restInstance.get<{
          params: {
            receive_enabled: boolean;
            send_enabled: boolean;
          };
        }>("/ibc/apps/transfer/v1/params");

        if (result.status === 200) {
          ibcGoUpdates = true;
        }
      }
    } catch {}

    let ibcTransferUpdate = false;
    try {
      if (!chainInfo.features || !chainInfo.features.includes("ibc-transfer")) {
        const isIBCGo =
          ibcGoUpdates ||
          (chainInfo.features && chainInfo.features.includes("ibc-go"));

        // If the chain doesn't have the ibc transfer feature,
        // try to fetch the params of ibc transfer module.
        // assume that it can support the ibc transfer if the params return true, and try to update the features.
        const result = await restInstance.get<{
          params: {
            receive_enabled: boolean;
            send_enabled: boolean;
          };
        }>(
          isIBCGo
            ? "/ibc/apps/transfer/v1/params"
            : "/ibc/applications/transfer/v1beta1/params"
        );
        if (
          result.data.params.receive_enabled &&
          result.data.params.send_enabled
        ) {
          ibcTransferUpdate = true;
        }
      }
    } catch {}

    let wasmd24Update = false;
    try {
      if (
        chainInfo.features?.includes("cosmwasm") &&
        !chainInfo.features.includes("wasmd_0.24+")
      ) {
        // It is difficult to decide which contract address to test on each chain.
        // So it simply sends a query that fails unconditionally.
        // However, if 400 bad request instead of 501 occurs, the url itself exists.
        // In this case, it is assumed that wasmd 0.24+ version.
        const result = await restInstance.get(
          "/cosmwasm/wasm/v1/contract/test/smart/test",
          {
            validateStatus: (status) => {
              return status === 400 || status === 501;
            },
          }
        );
        if (result.status === 400) {
          wasmd24Update = true;
        }
      }
    } catch {}

    let querySpendableBalances = false;
    try {
      if (
        !chainInfo.features ||
        !chainInfo.features.includes(
          "query:/cosmos/bank/v1beta1/spendable_balances"
        )
      ) {
        // It is difficult to decide which account to test on each chain.
        // So it simply sends a query that fails unconditionally.
        // However, if 400 bad request instead of 501 occurs, the url itself exists.
        // In this case, it is assumed that we can query /cosmos/bank/v1beta1/spendable_balances/{account}
        const result = await restInstance.get(
          "/cosmos/bank/v1beta1/spendable_balances/test",
          {
            validateStatus: (status) => {
              return status === 400 || status === 501;
            },
          }
        );
        if (result.status === 400) {
          querySpendableBalances = true;
        }
      }
    } catch {}

    const features: string[] = [];
    if (ibcGoUpdates) {
      features.push("ibc-go");
    }
    if (ibcTransferUpdate) {
      features.push("ibc-transfer");
    }
    if (wasmd24Update) {
      features.push("wasmd_0.24+");
    }
    if (querySpendableBalances) {
      features.push("query:/cosmos/bank/v1beta1/spendable_balances");
    }

    return {
      explicit: version.version < fetchedVersion.version,
      slient: features.length > 0,

      chainId: resultChainId,
      features,
    };
  }

  // XXX: It is not conceptually valid that the function to set the rpc/rest endpoint of the chain exists in this service.
  //      However, in order to focus on adding feature rather than making a big change, the refactor is postponed later and the configuration of the rpc/rest endpoint is handled here.

  public async setChainEndpoints(
    chainId: string,
    rpc: string | undefined,
    rest: string | undefined
  ): Promise<ChainInfoWithEmbed[]> {
    const chainInfo: Mutable<Partial<ChainInfo>> = {};

    // `saveChainProperty` method merges chain info using spread operator.
    // That is, if the field is undefined, the field is finally saved as undefined and the field is treated as if it were deleted.
    // To avoid this problem, the field must not exist. The implementation of the below is critical to its operation.
    if (rpc) {
      chainInfo.rpc = rpc;
    }
    if (rest) {
      chainInfo.rest = rest;
    }

    const version = ChainIdHelper.parse(chainId);

    await this.saveChainProperty(version.identifier, chainInfo);

    return await this.chainsService.getChainInfos();
  }

  public async resetChainEndpoints(
    chainId: string
  ): Promise<ChainInfoWithEmbed[]> {
    const version = ChainIdHelper.parse(chainId);

    // `saveChainProperty` method merges chain info using spread operator.
    // That is, if the field is undefined, the field is finally saved as undefined and the field is treated as if it were deleted.
    await this.saveChainProperty(version.identifier, {
      rpc: undefined,
      rest: undefined,
    });

    return await this.chainsService.getChainInfos();
  }
}
