import fs from 'fs-extra';
import Handlebars from 'handlebars';
import { natives } from "../../res/sampgdk.json";
import { EPaths } from '../enums';
import camelcase from 'camelcase';

type GdkNative = typeof natives[number];
type GdkArg = GdkNative["args"][number];
type GdkArgType = "int" | "float" | "bool" | "char *" | "int *" | "const char *" | "float *"; // | "TimerCallback" | "void *";

interface JuliaStructVar {
  name: string;
  type: string;
}

interface JuliaStruct {
  name: string;
  variables: JuliaStructVar[];
  ctor?: string;
}
  
interface JuliaStructAlias {
  struct: JuliaStruct;
  name: string;
}

interface ValueArgMetadata {
  kind: "value";
  name: string;
  argType: string;
  ctype: string;
  ccall: string;
}

interface ReferenceArgMetadata {
  kind: "reference";
  name: string;
  init?: string;
  ctype: string;
  ccall: string;
  cleanup?: string;
  trueType: string
}

type ArgMetadata = ValueArgMetadata | ReferenceArgMetadata;

interface JuliaNativeMetadata {
  name: string;
  variables: ArgMetadata[];
  return: {
    type: string;
    value: string;
    ctype: string;
  }
}

interface JuliaMetadata {
  // natives: { [native: string]: JuliaNativeMetadata };
  natives: JuliaNativeMetadata[];
}

const JuliaLibPath = "./plugins/jules-andreas.so";
const constants = {
  libPath: JuliaLibPath,
  returnTempVar: "__ret",
};

const juliaStructs: { [vars: string]: JuliaStructAlias } = prepopulatedStructs();
const recommendedDefaultSize = {
  ["SHA256_PassHash.ret_hash_size"]: 64,
  ["GetSVarString.string_return_size"]: 256,
  ["GetSVarNameAtIndex.ret_varname_size"]: 256,
  ["GetWeaponName.name_size"]: 32,
  ["GetPlayerNetworkStats.retstr_size"]: 400,
  ["GetNetworkStats.retstr_size"]: 400,
  ["GetPlayerVersion.version_size"]: 24,
  ["GetServerVarAsString.value_size"]: 256,
  ["GetConsoleVarAsString.buffer_size"]: 256,
  ["NetStats_GetIpPort.ip_port_size"]: 22,
  ["gpci.buffer_size"]: 40,
  ["FindModelFileNameFromCRC.model_str_size"]: 256,
  ["FindTextureFileNameFromCRC.texture_str_size"]: 256,
  ["GetPlayerIp.ip_size"]: 15,
  ["GetPlayerName.name_size"]: 32,
  ["GetPVarString.value_size"]: 256,
  ["GetPVarNameAtIndex.varname_size"]: 256,
  ["GetAnimationName.animlib_size"]: 32,
  ["GetAnimationName.animname_size"]: 32,
}

export async function generate() {
  const allowedNatives = natives.filter(n => n.name !== "SetTimer");
  const juliaNativesMetadata = allowedNatives.map(parseJuliaMetadata);

  juliaNativesMetadata.forEach(substituteInputInterfaces);

  const juliaMetadata: JuliaMetadata = { natives: juliaNativesMetadata };


  const structs = new Set(Object.values(juliaStructs).map(v => v.struct)).values();

  const juliaNativesTemplate = Handlebars.compile(await fs.readFile(EPaths.TEMPLATE_JULIA, 'utf8'));
  await fs.outputFile(EPaths.GENERATED_JULIA_NATIVES, juliaNativesTemplate({ constants, juliaStructs: structs, juliaMetadata }));
}


function parseJuliaMetadata(native: GdkNative): JuliaNativeMetadata {

  const variables = native.args.map(getArgMetadata);

  const basicMetadata: JuliaNativeMetadata = {
    name: native.name,
    variables,
    return: { 
      type: gdkToJuliaArgType(native.returnType)!, 
      ctype: gdkToJuliaCcallType(native.returnType),
      value: constants.returnTempVar
    }
  };

  substituteSize(basicMetadata);
  const interfaceReadyMetadata = prepareInterface(basicMetadata);
  const finalInterface = interfaceReadyMetadata;
  return finalInterface;
}

function substituteSize(metadata: JuliaNativeMetadata) {
  metadata.variables.forEach((v, idx, array) => {
      if (v.kind === "reference" && v.trueType === "String") {
        const sizeVar = array[idx + 1];
        if (!/(size)|(len)/.test(sizeVar.name) || sizeVar.kind !== "value" || sizeVar.argType !== "Int32") {
          throw new Error(`Expected len for ${v.name} in ${metadata.name} but got ${sizeVar.name}`);
        }
        sizeVar.name = v.name + "_size";
        sizeVar.ccall = sizeVar.name;

        const sizeKey = `${metadata.name}.${sizeVar.name}`;
        const defaultValue = recommendedDefaultSize[sizeKey];
        if (!defaultValue) {
          throw new Error(`No default length for ${sizeKey}`)
        }
        sizeVar.argType += " = " + defaultValue
      }
  });
}

function prepareInterface(metadata: JuliaNativeMetadata): JuliaNativeMetadata {
  const returnArgs = metadata.variables.filter(v => v.kind === "reference") as ReferenceArgMetadata[];
  if (returnArgs.length === 0) {
    return metadata;
  }

  if (returnArgs.length === 1) {
    const arg = returnArgs[0]
    metadata.return.value = arg.name;
    metadata.return.type = arg.trueType;
    return metadata;
  }

  const structAlias = findOrCreateAlias(metadata.name, returnArgs);
  metadata.return.type = structAlias.struct.name;
  metadata.return.value = `${structAlias.struct.name}(${returnArgs.map(a => a.name).join(", ")})`;

  return metadata;
}

function substituteInputInterfaces(metadata: JuliaNativeMetadata): JuliaNativeMetadata {
  let inputArgs = metadata.variables.filter(v => v.kind === "value") as ValueArgMetadata[]; 
  for (let startIdx = 0; startIdx < inputArgs.length; startIdx++) {
      const args = inputArgs.slice(startIdx);
      while (args.length > 1) {
        const typedArgs = args.map(arg => `${arg.name}::${arg.argType}`);
        const key = typedArgs.toString();
        const existingAlias = juliaStructs[key];
        if (existingAlias) {
          const trueIndex = metadata.variables.findIndex(a => a.name === args[0].name);
          const structVariableName = camelcase(existingAlias.name);
          metadata.variables.splice(trueIndex, 0, { 
            kind: "value",
            argType: existingAlias.struct.name,
            name: structVariableName,
            ccall: "",
            ctype: "",
          });
          // won't work for last shot vector, but it's not used for inputs anyway
          args.forEach((a, idx) => {
            a.argType = "";
            a.ccall = `${structVariableName}.${existingAlias.struct.variables[idx].name}`;
          });
          
          inputArgs = metadata.variables.filter(v => v.kind === "value") as ValueArgMetadata[]; 
          startIdx += args.length + 1;
          break;
        }
        args.pop();
      }
  }
  return metadata;
}

function findOrCreateAlias(methodName: string, args: ReferenceArgMetadata[]): JuliaStructAlias {
  const typedArgs = args.map(arg => ({ name: arg.name, type: arg.trueType }));
  const key = getAliasKey(typedArgs);
  const existingAlias = juliaStructs[key];
  if (existingAlias) {
    // console.log(`Reusing alias ${existingAlias.name} for ${methodName}`)
    return existingAlias;
  }

  const prefixMatch = /((Get)|(Find)|(SHA256_)|(NetStats_Get))(.+)/.exec(methodName);
  if (prefixMatch == null) {
    throw new Error(`Not sure what name to set for ${methodName}`);
  }

  const prefix = prefixMatch[1];
  const name = methodName.substring(prefix?.length ?? 0);
  const struct: JuliaStruct = {
    name,
    variables: typedArgs,
  };
  return registerStructAlias(juliaStructs, struct, name, typedArgs);
}

function getArgMetadata(gdkArg: GdkArg): JuliaNativeMetadata["variables"][number] {
  const name = gdkArg.name;
  switch (gdkArg.type as GdkArgType) {
    case "bool": return {
      kind: "value",
      name,
      argType: "Bool",
      ctype: "Cuchar",
      ccall: name,
    };
    case "int": return {
      kind: "value",
      name,
      argType: "Int32",
      ctype: "Cint",
      ccall: name,
    };
    case "float": return {
      kind: "value",
      name,
      argType: "Float32",
      ctype: "Cfloat",
      ccall: name,
    };
    case "int *": return {
      kind: "reference",
      name,
      init: `${name}::Int32 = 0`, 
      ctype: "Ref{Cint}",
      ccall: name,
      trueType: "Int32",
    };
    case "float *": return {
      kind: "reference",
      name,
      init: `${name}::Float32 = 0`,
      ctype: "Ref{Cfloat}",
      ccall: name,
      trueType: "Float32",
    };
    case "char *": return {
      kind: "reference",
      name,
      init: `__${name}_buf = Vector{UInt8}(undef, 1 + ${name}_size)`,
      ctype: "Ptr{UInt8}",
      ccall: `__${name}_buf`,
      cleanup: `${name} = unsafe_string(pointer(__${name}_buf))`,
      trueType: "String",
    };
    case "const char *": return {
      kind: "value",
      name,
      argType: "String",
      ctype: "Cstring",
      ccall: name,
    }
    default:
      throw new Error(`Unhandled arg type ${gdkArg.type}`);
  }
}


function gdkToJuliaArgType(gdkArgType: GdkArg["type"]) {
  switch (gdkArgType as GdkArgType) {
    case "bool": return "Bool";
    case "int": return "Int32";
    case "float": return "Float32";
    case "const char *": return "String";
    case "char *":
    case "int *":
    case "float *":
      return undefined;
    default:
      throw new Error(`Unhandled arg type ${gdkArgType}`);
  }
}

function gdkToJuliaCcallType(gdkArgType: GdkArg["type"]) {
  switch (gdkArgType as GdkArgType) {
    case "bool": return "Cuchar";
    case "int": return "Cint";
    case "float": return "Cfloat";
    case "int *": return "Ref{Cint}"
    case "float *": return "Ref{Cfloat}";
    case "char *": return "Ptr{UInt8}";
    case "const char *": return "Cstring";
    default:
      throw new Error(`Unhandled arg type ${gdkArgType}`);
  }
}

function isOutputType(gdkArgType: GdkArg["type"]) {
  switch (gdkArgType as GdkArgType) {
    case "bool":
    case "int":
    case "float":
    case "const char *":
      return false;
    case "int *":
    case "float *":
    case "char *":
      return true;
    default:
      throw new Error(`Unhandled arg type ${gdkArgType}`);
  }
}

function prepopulatedStructs(): typeof juliaStructs {
  const addTypes = (vars: string[]) => vars.map(v => ({ name: v, type: "Float32" }));

  const aliasMap: typeof juliaStructs = {};

  const vector2 = {
    name: "Vector2",
    variables: addTypes(["x", "y"]),
  };

  const vector3 = {
    name: "Vector3",
    variables: addTypes(["x", "y", "z"]),
  };

  const vector4 = {
    name: "Vector4",
    variables: addTypes(["w", "x", "y", "z"]),
  };

  const shotVector = {
    name: "ShotVector",
    variables: [{name: "originPos", type: "Vector3"}, {name: "hitPos", type: "Vector3"}],
    ctor: "ShotVector(oX, oY, oZ, hX, hY, hZ) = new(Vector3(oX, oY, oZ), Vector3(hX, hY, hZ))",
  }

  registerStructAlias(aliasMap, vector2, "position", addTypes(["x", "y"]));
  registerStructAlias(aliasMap, vector3, "position", addTypes(["x", "y", "z"]));
  registerStructAlias(aliasMap, vector3, "position", addTypes(["X", "Y", "Z"]));
  registerStructAlias(aliasMap, vector3, "position", addTypes(["fX", "fY", "fZ"]));
  registerStructAlias(aliasMap, vector3, "position", addTypes(["spawn_x", "spawn_y", "spawn_z"]));
  registerStructAlias(aliasMap, vector3, "offset", addTypes(["fOffsetX", "fOffsetY", "fOffsetZ"]));
  registerStructAlias(aliasMap, vector3, "scale", addTypes(["fScaleX", "fScaleY", "fScaleZ"]));
  registerStructAlias(aliasMap, vector3, "rotation", addTypes(["fRotX", "fRotY", "fRotZ"]));
  registerStructAlias(aliasMap, vector3, "rotation", addTypes(["rotX", "rotY", "rotZ"]));
  registerStructAlias(aliasMap, vector3, "fromPos", addTypes(["FromX", "FromY", "FromZ"]));
  registerStructAlias(aliasMap, vector3, "toPos", addTypes(["ToX", "ToY", "ToZ"]));
  registerStructAlias(aliasMap, vector4, "rotation", addTypes(["w", "x", "y", "z"]));
  registerStructAlias(aliasMap, shotVector, "shotVector", addTypes(["fOriginX", "fOriginY", "fOriginZ", "fHitPosX", "fHitPosY", "fHitPosZ"]));

  return aliasMap;
}

function assertNever(x: never): never {
  throw new Error("Unexpected object: " + x);
}

function registerStructAlias(aliasMap: typeof juliaStructs, struct: JuliaStruct, name: string, vars: JuliaStructVar[]): JuliaStructAlias {
  if (vars.length !== struct.variables.length && !struct.ctor) {
    throw new Error(`Invalid alias ${name} for ${struct.name} - contains ${vars.length} vars instead of ${struct.variables.length}`);
  }
  const alias: JuliaStructAlias = { name, struct };
  aliasMap[getAliasKey(vars)] = alias;
  return alias;
}

function getAliasKey(vars: JuliaStructVar[]) {
  return vars.map(v => `${v.name}::${v.type}`).toString()
}


/*
  switch (gdkArgType as GdkArgType) {
    case "bool":
    case "int":
    case "float":
    case "int *":
    case "float *":
    case "char *":
    case "const char *":
      return;
    default:
      throw new Error(`Unhandled arg type ${gdkArgType}`);
  }
*/