import { OpenAPIV3 } from 'openapi-types'
import { Collection } from 'postman-collection'
import {
  applyOverwrites,
  assignCollectionVariables,
  extendTest,
  testResponseBodyContent,
  testResponseContentType,
  testResponseHeader,
  testResponseJsonBody,
  testResponseJsonSchema,
  testResponseStatusCode,
  testResponseStatusSuccess,
  testResponseTime,
  VariationWriter
} from '.'
import { OasMappedOperation, OpenApiParser } from '../oas'
import { PostmanMappedOperation, PostmanParser } from '../postman'
import {
  AssignVariablesConfig,
  ContentTestConfig,
  ContractTestConfig,
  ExtendTestsConfig,
  OverwriteRequestConfig,
  PortmanConfig,
  ResponseTime,
  StatusCode,
  TestSuiteOptions,
  VariationTestConfig
} from '../types'
import { inRange } from '../utils'
import { inOperations } from '../utils/inOperations'

export class TestSuite {
  public collection: Collection

  oasParser: OpenApiParser
  postmanParser: PostmanParser
  config: PortmanConfig

  contractTests?: ContractTestConfig[]
  contentTests?: ContentTestConfig[]
  variationTests?: VariationTestConfig[]
  extendTests?: ExtendTestsConfig[]

  pmResponseJsonVarInjected: boolean

  constructor(options: TestSuiteOptions) {
    const { oasParser, postmanParser, config } = options

    this.pmResponseJsonVarInjected = false

    this.oasParser = oasParser
    this.postmanParser = postmanParser
    this.config = config

    this.collection = postmanParser.collection
    this.setupTests()
  }

  setupTests = (): void => {
    if (!this.config?.tests) return

    this.contractTests = this.config?.tests?.contractTests
    this.contentTests = this.config?.tests?.contentTests
    this.variationTests = this.config?.tests?.variationTests
    this.extendTests = this.config?.tests?.extendTests
  }

  public generateContractTests = (
    pmOperations?: PostmanMappedOperation[],
    oaOperation?: OasMappedOperation,
    contractTests?: ContractTestConfig[]
  ): void => {
    const tests = contractTests || this.contractTests

    if (!tests) return

    tests.map(contractTest => {
      const operations = pmOperations || this.getOperationsFromSetting(contractTest)

      operations.map(pmOperation => {
        // Get OpenApi responses
        const operation = oaOperation || this.oasParser.getOperationByPath(pmOperation.pathRef)

        if (operation) {
          // Inject response tests
          this.injectContractTests(pmOperation, operation, contractTest)
        }
      })
    })
  }

  public generateVariationTests = (): void => {
    if (!this.variationTests) return

    const variationTests = this.variationTests
    const variationWriter = new VariationWriter({ testSuite: this })

    variationTests.map(variationTest => {
      //Get Postman operations to inject variation test for
      const pmOperations = this.getOperationsFromSetting(variationTest)

      pmOperations.map(pmOperation => {
        // Get OpenApi responses
        const oaOperation = this.oasParser.getOperationByPath(pmOperation.pathRef)
        variationWriter.add(pmOperation, oaOperation, variationTest.variations)
      })
    })

    this.collection = variationWriter.mergeToCollection(this.collection)
  }

  public getOperationsFromSetting(
    settings:
      | ContractTestConfig
      | OverwriteRequestConfig
      | AssignVariablesConfig
      | ContentTestConfig
      | VariationTestConfig
  ): PostmanMappedOperation[] {
    const { openApiOperation, openApiOperationId } = settings

    let pmOperations: PostmanMappedOperation[] = []

    if (openApiOperation) {
      pmOperations = this.postmanParser.getOperationsByPath(openApiOperation)
    } else if (openApiOperationId) {
      pmOperations = this.postmanParser.getOperationsByIds([openApiOperationId])
    }

    if (settings?.excludeForOperations) {
      const excludedOperations = settings.excludeForOperations
      pmOperations = pmOperations.filter((pmOperation: PostmanMappedOperation) => {
        return (
          pmOperation?.id &&
          !excludedOperations.includes(pmOperation?.id) &&
          !excludedOperations.includes(pmOperation?.pathRef)
        )
      })
    }

    return pmOperations
  }

  public getTestTypeFromContractTests = (
    contractTest: ContractTestConfig,
    type: string
  ): ContractTestConfig | undefined => {
    return contractTest[type]
  }

  public injectContractTests = (
    pmOperation: PostmanMappedOperation,
    oaOperation: OasMappedOperation,
    contractTest: ContractTestConfig
  ): PostmanMappedOperation => {
    // Early exit if no responses defined
    if (!oaOperation.schema?.responses) return pmOperation

    // Process all responses
    for (const [code, response] of Object.entries(oaOperation.schema.responses)) {
      const responseObject = response as OpenAPIV3.ResponseObject

      // Only support 2xx response checks - Happy path
      if (!inRange(parseInt(code), 200, 302)) {
        continue // skip this response
      }

      // List excludeForOperations
      const optStatusSuccess = this.getTestTypeFromContractTests(contractTest, 'statusSuccess')
      const optStatusCode = this.getTestTypeFromContractTests(contractTest, 'statusCode')
      const optResponseTime = this.getTestTypeFromContractTests(contractTest, 'responseTime')
      const optContentType = this.getTestTypeFromContractTests(contractTest, 'contentType')
      const optJsonBody = this.getTestTypeFromContractTests(contractTest, 'jsonBody')
      const optSchemaValidation = this.getTestTypeFromContractTests(
        contractTest,
        'schemaValidation'
      )
      const optHeadersPresent = this.getTestTypeFromContractTests(contractTest, 'headersPresent')

      // Add status success check
      if (optStatusSuccess && !inOperations(pmOperation, optStatusSuccess?.excludeForOperations)) {
        pmOperation = testResponseStatusSuccess(pmOperation)
      }

      // Add status code check
      if (optStatusCode && !inOperations(pmOperation, optStatusCode?.excludeForOperations)) {
        pmOperation = testResponseStatusCode(optStatusCode as StatusCode, pmOperation)
      }

      // Add responseTime check
      if (optResponseTime && !inOperations(pmOperation, optResponseTime?.excludeForOperations)) {
        pmOperation = testResponseTime(optResponseTime as ResponseTime, pmOperation)
      }

      // Add response content checks
      if (responseObject.content) {
        // Process all content-types
        for (const [contentType, content] of Object.entries(responseObject.content)) {
          // Early skip if no content-types defined
          if (!contentType) continue

          // Add contentType check
          if (optContentType && !inOperations(pmOperation, optContentType?.excludeForOperations)) {
            pmOperation = testResponseContentType(contentType, pmOperation, oaOperation)
          }

          // Add json body check
          if (
            optJsonBody &&
            contentType === 'application/json' &&
            !inOperations(pmOperation, optJsonBody?.excludeForOperations)
          ) {
            pmOperation = testResponseJsonBody(pmOperation, oaOperation)
          }

          // Add json schema check
          if (
            optSchemaValidation &&
            content?.schema &&
            !inOperations(pmOperation, optSchemaValidation?.excludeForOperations)
          ) {
            pmOperation = testResponseJsonSchema(content?.schema, pmOperation, oaOperation)
          }
        }
      }

      if (responseObject.headers) {
        // Process all response headers
        for (const [headerName] of Object.entries(responseObject.headers)) {
          // Early skip if no schema defined
          if (!headerName) continue
          // Add response header checks headersPresent
          if (
            optHeadersPresent &&
            !inOperations(pmOperation, optHeadersPresent?.excludeForOperations)
          ) {
            pmOperation = testResponseHeader(headerName, pmOperation, oaOperation)
          }
        }
      }
    }
    return pmOperation
  }

  public injectContentTests = (
    pmOperations?: PostmanMappedOperation[],
    contentTests?: ContentTestConfig[]
  ): PostmanMappedOperation[] => {
    if (!this.contentTests) return this.postmanParser.mappedOperations

    const tests = contentTests || this.contentTests

    tests.map(contentTest => {
      //Get Postman operations to inject content test for
      const operations = pmOperations || this.getOperationsFromSetting(contentTest)

      operations.map(pmOperation => {
        // check content of response body
        if (contentTest?.responseBodyTests) {
          testResponseBodyContent(contentTest.responseBodyTests, pmOperation)
        }
      })
    })

    return this.postmanParser.mappedOperations
  }

  public injectAssignVariables = (
    pmOperations?: PostmanMappedOperation[],
    assignVariables?: AssignVariablesConfig[]
  ): PostmanMappedOperation[] => {
    if (!this.config?.assignVariables) return this.postmanParser.mappedOperations
    const settings = assignVariables || this.config.assignVariables

    settings.map(assignVarSetting => {
      if (!assignVarSetting?.collectionVariables) return
      // Get Postman operations to apply assign variables for
      const operations = pmOperations || this.getOperationsFromSetting(assignVarSetting)
      let fixedValueCounter = 0

      operations.map(pmOperation => {
        // Loop over all defined variable value sources
        fixedValueCounter = assignCollectionVariables(
          pmOperation,
          assignVarSetting,
          fixedValueCounter
        ) as number
      })
    })

    return this.postmanParser.mappedOperations
  }

  public injectExtendedTests = (
    pmOperations?: PostmanMappedOperation[],
    extendedTestsSettings?: ExtendTestsConfig[]
  ): PostmanMappedOperation[] => {
    if (!this.extendTests) return this.postmanParser.mappedOperations
    const settings = extendedTestsSettings || this.extendTests

    settings.map(extendedTestsSetting => {
      //Get Postman operations to apply assign variables for
      const operations = pmOperations || this.getOperationsFromSetting(extendedTestsSetting)
      operations.map(pmOperation => {
        // Assign Postman collection variable with a request body value
        if (extendedTestsSetting?.tests) {
          extendTest(extendedTestsSetting, pmOperation)
        }
      })
    })

    return this.postmanParser.mappedOperations
  }

  public injectOverwrites = (
    pmOperations?: PostmanMappedOperation[],
    overwriteSettings?: OverwriteRequestConfig[]
  ): PostmanMappedOperation[] => {
    if (!this.config?.overwrites) return this.postmanParser.mappedOperations

    const settings = overwriteSettings || this.config.overwrites

    settings.map(overwriteSetting => {
      //Get Postman operations to apply overwrites to
      const operations = pmOperations || this.getOperationsFromSetting(overwriteSetting)
      applyOverwrites(operations, overwriteSetting)
    })

    return this.postmanParser.mappedOperations
  }
}